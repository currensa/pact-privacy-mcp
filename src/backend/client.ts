import type { AccountRecord, ChainDetails, ChainFamily, ChainSummary } from "../core/types.js";
import type { ApiKeyCreated, ApiKeyIdentity } from "../api-keys/types.js";
import { apiKeyCreatePayloadHash, apiKeyManagePayloadHash, type ApiKeyAction } from "../api-keys/authorization.js";
import { normalizeAddress } from "../chain/address.js";
import { normalizeBackendUrl } from "../config/env.js";
import { LocalSigner, type AuthorizationChallenge } from "../wallet/local-signer.js";

export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BackendError";
  }
}

type RequestOptions = RequestInit & { authenticated?: boolean };

export class PactPrivacyBackend {
  readonly apiBase: string;
  private cookie: string | undefined;

  constructor(
    backendUrl: string,
    private readonly apiKey: string | undefined = undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const base = normalizeBackendUrl(backendUrl);
    this.apiBase = base.endsWith("/api") ? base : `${base}/api`;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    if (options.authenticated && this.cookie) headers.set("Cookie", this.cookie);
    const response = await this.fetchImpl(`${this.apiBase}${path}`, { ...options, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0];
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
      const detail = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
      throw new BackendError(response.status, detail ?? `Backend request failed (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  chains(): Promise<ChainSummary[]> {
    return this.request<ChainSummary[]>("/config/chains");
  }

  async chain(chainId: number): Promise<ChainDetails> {
    const [summary, details] = await Promise.all([
      this.chains().then((chains) => chains.find((entry) => entry.chainId === chainId)),
      this.request<Omit<ChainDetails, keyof ChainSummary>>(`/config?chainId=${encodeURIComponent(String(chainId))}`),
    ]);
    if (!summary) throw new Error(`Unsupported chain: ${chainId}`);
    return { ...summary, ...details } as ChainDetails;
  }

  challenge(
    address: string,
    family: ChainFamily,
    action: "login" | "account-update" | ApiKeyAction,
    payloadHash?: string,
  ): Promise<AuthorizationChallenge> {
    return this.request<AuthorizationChallenge>("/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address, family, action, payloadHash }),
    });
  }

  async authenticate(signer: LocalSigner, family: ChainFamily): Promise<void> {
    const address = signer.address(family);
    const value = await this.challenge(address, family, "login");
    const signature = await signer.signChallenge(value);
    const session = await this.request<{ authenticated: boolean; address: string; family: ChainFamily }>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ address, family, nonce: value.nonce, signature }),
    });
    if (!session.authenticated || normalizeAddress(session.address, family) !== address || session.family !== family) {
      throw new Error("Backend session identity does not match the local private key");
    }
  }

  account(): Promise<AccountRecord> {
    return this.request<AccountRecord>("/user", { authenticated: true });
  }

  async createAccount(
    signer: LocalSigner,
    family: ChainFamily,
    registration: {
      encryptedSecret: string;
      secretHash: string;
      encPubkey: string;
      payloadHash: string;
    },
  ): Promise<void> {
    const address = signer.address(family);
    const challenge = await this.challenge(address, family, "account-update", registration.payloadHash);
    const signature = await signer.signChallenge(challenge);
    await this.request("/user", {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({
        encryptedSecret: registration.encryptedSecret,
        secretHash: registration.secretHash,
        encPubkey: registration.encPubkey,
        authorization: { nonce: challenge.nonce, signature },
      }),
    });
  }

  apiKeyIdentity(): Promise<ApiKeyIdentity> {
    return this.request<ApiKeyIdentity>("/api-keys/self");
  }

  async assertApiKeyGrant(signer: LocalSigner, family: ChainFamily): Promise<ApiKeyIdentity> {
    if (!this.apiKey) throw new Error("PACT_PRIVACY_API_KEY is required");
    const identity = await this.apiKeyIdentity();
    const address = signer.address(family);
    const permitted = identity.grants.some((grant) => (
      grant.family === family && normalizeAddress(grant.address, family) === address
    ));
    if (!permitted) throw new Error(`API key does not grant ${address} (${family})`);
    return identity;
  }

  private async managementAuthorization(
    signer: LocalSigner,
    family: ChainFamily,
    action: Exclude<ApiKeyAction, "api-key-create">,
    keyId: string,
  ): Promise<{ nonce: string; signature: string }> {
    const address = signer.address(family);
    const payloadHash = apiKeyManagePayloadHash({ operation: action, keyId, address, family });
    const challenge = await this.challenge(address, family, action, payloadHash);
    return { nonce: challenge.nonce, signature: await signer.signChallenge(challenge) };
  }

  async createApiKey(
    signer: LocalSigner,
    family: ChainFamily,
    input: { name: string; scopes: string[]; expiresAt: number | null },
  ): Promise<ApiKeyCreated> {
    const address = signer.address(family);
    const payloadHash = apiKeyCreatePayloadHash({ ...input, address, family });
    const challenge = await this.challenge(address, family, "api-key-create", payloadHash);
    const authorization = { nonce: challenge.nonce, signature: await signer.signChallenge(challenge) };
    return this.request<ApiKeyCreated>("/api-keys", {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({ ...input, authorization }),
    });
  }

  async addApiKeyGrant(signer: LocalSigner, family: ChainFamily, id: string): Promise<ApiKeyIdentity> {
    const authorization = await this.managementAuthorization(signer, family, "api-key-grant", id);
    return this.request<ApiKeyIdentity>(`/api-keys/${encodeURIComponent(id)}/grants`, {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({ authorization }),
    });
  }

  async rotateApiKey(signer: LocalSigner, family: ChainFamily, id: string): Promise<ApiKeyCreated> {
    const authorization = await this.managementAuthorization(signer, family, "api-key-rotate", id);
    return this.request<ApiKeyCreated>(`/api-keys/${encodeURIComponent(id)}/rotate`, {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({ authorization }),
    });
  }
}
