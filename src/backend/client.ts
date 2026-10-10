import type {
  AccountRecord,
  ChainDetails,
  ChainFamily,
  ChainSummary,
  DepositionRecord,
  EncryptedAllocation,
  RegisteredReceiver,
} from "../core/types.js";
import type { ApiKeyCreated, ApiKeyIdentity } from "../api-keys/types.js";
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

type OrganizationNetwork = {
  caipChainId: string;
  chainId: number;
  chainName: string;
  family: ChainFamily;
  nativeCurrency: NonNullable<ChainSummary["nativeCurrency"]>;
  rpcUrls: string[];
  blockExplorerUrls: string[];
  contracts: { gravArc: string; pureRouter: string; defiRouter: string };
  tokens: ChainDetails["erc20Tokens"];
  protocols: ChainDetails["defiProtocols"];
  capabilities: { deposit: boolean; withdraw: boolean; refund: boolean; defi: boolean; relayed: boolean };
};

export class PactPrivacyBackend {
  readonly apiBase: string;
  private sessionToken: string | undefined;
  private expectedWalletAddress: string | undefined;

  constructor(
    backendUrl: string,
    private readonly apiKey: string | undefined = undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const base = normalizeBackendUrl(backendUrl);
    this.apiBase = base.endsWith("/api") ? base : `${base}/api`;
    const endpoint = new URL(this.apiBase);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) {
      throw new Error("Organization backend requires HTTPS outside localhost");
    }
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (options.authenticated) {
      if (!this.sessionToken) throw new Error("Organization wallet login is required");
      headers.set("Authorization", `Bearer ${this.sessionToken}`);
    } else if (this.apiKey) headers.set("x-api-key", this.apiKey);
    const response = await this.fetchImpl(`${this.apiBase}${path}`, { ...options, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
      const detail = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
      throw new BackendError(response.status, detail ?? `Backend request failed (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async networks(): Promise<OrganizationNetwork[]> {
    const rows = await this.request<OrganizationNetwork[]>("/chain-asset/networks");
    if (!Array.isArray(rows)) throw new Error("Organization network response is invalid");
    const evm = rows.filter((row) => row.family === "evm");
    for (const row of evm) {
      if (row.caipChainId !== `eip155:${row.chainId}`
        || !Array.isArray(row.rpcUrls) || !row.rpcUrls[0] || !row.nativeCurrency
        || !row.contracts?.gravArc || !Array.isArray(row.tokens) || !Array.isArray(row.protocols)
        || typeof row.capabilities?.relayed !== "boolean") {
        throw new Error("Organization network response is invalid");
      }
    }
    return evm;
  }

  async chains(): Promise<ChainSummary[]> {
    return (await this.networks()).map((row) => ({
      chainId: row.chainId,
      chainName: row.chainName,
      family: row.family,
      capabilities: row.capabilities,
      rpcUrl: row.rpcUrls[0]!,
      rpcUrls: row.rpcUrls,
      nativeCurrency: row.nativeCurrency,
      blockExplorerUrls: row.blockExplorerUrls,
    }));
  }

  async chain(chainId: number): Promise<ChainDetails> {
    const row = (await this.networks()).find((entry) => entry.chainId === chainId);
    if (!row) throw new Error(`Unsupported chain: ${chainId}`);
    return {
      chainId: row.chainId,
      chainName: row.chainName,
      family: row.family,
      capabilities: row.capabilities,
      rpcUrl: row.rpcUrls[0]!,
      rpcUrls: row.rpcUrls,
      nativeCurrency: row.nativeCurrency,
      blockExplorerUrls: row.blockExplorerUrls,
      gravArc: row.contracts.gravArc as ChainDetails["gravArc"],
      pureRouter: row.contracts.pureRouter as NonNullable<ChainDetails["pureRouter"]>,
      pactPrivacyDefiRouter: row.contracts.defiRouter as NonNullable<ChainDetails["pactPrivacyDefiRouter"]>,
      erc20Tokens: row.tokens,
      defiProtocols: row.protocols,
    };
  }

  challenge(
    address: string,
    family: ChainFamily,
    action: "login" | "privacy-profile-register",
    payloadHash = `0x${"00".repeat(32)}`,
  ): Promise<AuthorizationChallenge> {
    return this.request<AuthorizationChallenge>("/auth/wallet/challenge", {
      method: "POST",
      body: JSON.stringify({ address, family, action, payloadHash }),
    });
  }

  async authenticate(signer: LocalSigner, family: ChainFamily): Promise<void> {
    const address = signer.address(family);
    const value = await this.challenge(address, family, "login");
    const signature = await signer.signChallenge(value);
    const session = await this.request<{ userId: string; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ type: "wallet", address, family, nonce: value.nonce, signature }),
    });
    if (!session.userId || !session.token) throw new Error("Organization wallet login response is invalid");
    this.sessionToken = session.token;
    const me = await this.me(true);
    if (me.user.userId !== session.userId || !me.accounts.some((account) => account.type === "wallet"
      && normalizeAddress(account.account, family) === address)) {
      this.sessionToken = undefined;
      throw new Error("Backend session identity does not match the local private key");
    }
    this.expectedWalletAddress = address;
  }

  me(authenticated = false): Promise<{
    user: { userId: string };
    accounts: Array<{ type: string; account: string }>;
  }> {
    return this.request("/auth/me", { authenticated });
  }

  async account(family: ChainFamily = "evm"): Promise<AccountRecord> {
    if (family !== "evm") throw new Error(`Unsupported Organization wallet family: ${family}`);
    const profile = await this.request<{
      address: string; encryptedSecret: string; secretHash: string; encPubkey: string | null;
    } | null>("/auth/gravarc-user-info/detail", { authenticated: Boolean(this.sessionToken) });
    if (profile && this.expectedWalletAddress
      && normalizeAddress(profile.address, family) !== this.expectedWalletAddress) {
      throw new Error("Organization privacy profile belongs to a different wallet");
    }
    return profile ? { found: true, ...profile } : {
      found: false, encryptedSecret: null, secretHash: null, encPubkey: null,
    };
  }

  async users(family: ChainFamily, orgId: string): Promise<RegisteredReceiver[]> {
    if (family !== "evm") throw new Error(`Unsupported Organization wallet family: ${family}`);
    if (!orgId) throw new Error("Organization ID is required");
    const members: Array<{ memberId: string; gravArcAddress: string | null }> = [];
    for (let page = 1; ; page += 1) {
      const result = await this.request<{
        data: Array<{ memberId: string; gravArcAddress: string | null }>;
        total: number; page: number; pageSize: number;
      }>(`/orgs/${encodeURIComponent(orgId)}/members?status=active&page=${page}&pageSize=100`);
      if (!Array.isArray(result.data) || !Number.isSafeInteger(result.total) || result.total < 0
        || result.page !== page || result.pageSize !== 100) throw new Error("Organization member list is invalid");
      members.push(...result.data.filter((member) => member.gravArcAddress));
      if (page * 100 >= result.total) break;
    }
    const addresses = members.map((member) => normalizeAddress(member.gravArcAddress!, "evm"));
    const profiles: RegisteredReceiver[] = [];
    for (let index = 0; index < addresses.length; index += 100) {
      const group = addresses.slice(index, index + 100);
      if (group.length === 0) break;
      const rows = await this.recipientProfiles(group);
      if (!Array.isArray(rows)) throw new Error("Organization recipient profiles are invalid");
      profiles.push(...rows);
    }
    const byAddress = new Map(profiles.map((profile) => [normalizeAddress(profile.address, "evm"), profile]));
    return members.flatMap((member) => {
      const profile = byAddress.get(normalizeAddress(member.gravArcAddress!, "evm"));
      return profile ? [{ ...profile, memberId: member.memberId }] : [];
    });
  }

  recipientProfiles(addresses: string[]): Promise<RegisteredReceiver[]> {
    if (addresses.length < 1 || addresses.length > 128) throw new Error("Select 1–128 recipients");
    return this.request<RegisteredReceiver[]>(`/transaction/defi/recipient-profiles?addresses=${addresses.map(encodeURIComponent).join(",")}`);
  }

  createPrivacyDepositPlan(orgId: string, input: {
    caipChainId: string; tokenAddress: string; privacyRefundable: boolean;
    members: Array<{ memberId: string }>; encryptedPlan: string;
  }): Promise<{ batchId: string; tier: number; caipChainId: string; tokenAddress: string;
    members: Array<{ address: string | null; secretHash: string | null; encPubkey: string | null }> }> {
    return this.request(`/transaction/${encodeURIComponent(orgId)}/privacy-deposit-plan`, {
      method: "POST", body: JSON.stringify(input),
    });
  }

  privacyDepositData(orgId: string, batchId: string): Promise<{
    batchId: string; caipChainId: string; tokenAddress: string; tier: number;
    privacyRefundable: boolean; transactionStatus: string; depositorAddress: string;
    encryptedPlan: string; members: Array<{ memberId: string; address: string; secretHash: string; encPubkey: string }>;
  }> {
    return this.request(`/transaction/${encodeURIComponent(orgId)}/batches/${encodeURIComponent(batchId)}/privacy-deposit-data`);
  }

  confirmPrivacyDeposit(orgId: string, batchId: string, input: {
    depositTxHash: string; withdrawMessages: Array<{
      address: string; content: string; secretHash: string; encPubkey: string; clientMessageId: string;
    }>;
    encContent: string; depositInfo: string; clientRefundId: string;
  }): Promise<{ success: boolean }> {
    return this.request(`/transaction/${encodeURIComponent(orgId)}/batches/${encodeURIComponent(batchId)}/confirm-deposit`, {
      method: "POST", body: JSON.stringify(input),
    });
  }

  confirmPrivacyWithdraw(itemId: string, txHash: string): Promise<{ status: string; txHash: string }> {
    return this.request(`/transaction/my-payroll-items/${encodeURIComponent(itemId)}/confirm-withdraw`, {
      method: "POST", body: JSON.stringify({ txHash }),
    });
  }

  async depositions(chainId: number): Promise<DepositionRecord[]> {
    const [owner, memberships] = await Promise.all([this.me(), this.organizations()]);
    const results: DepositionRecord[] = [];
    for (const membership of memberships) {
      if (membership.member.status !== "active" || !membership.member.roles.some(({ role }) =>
        ["Owner", "Admin", "Operator"].includes(role))) continue;
      const orgId = membership.organization.orgId;
      for (let page = 1; ; page += 1) {
        const rows = await this.request<{
          data: Array<{ id: string; createdBy: string; caipChainId: string; transactionType: string;
            transactionStatus: string; privacyRefundable: boolean | null; privacyLeafIndex: number | null;
            items: unknown[] }>;
          total: number; page: number; pageSize: number;
        }>(`/transaction/${encodeURIComponent(orgId)}?page=${page}&pageSize=100`);
        if (!Array.isArray(rows.data) || !Number.isSafeInteger(rows.total) || rows.page !== page
          || rows.pageSize !== 100) throw new Error("Organization transaction list is invalid");
        for (const batch of rows.data) {
          if (batch.createdBy !== owner.user.userId || batch.caipChainId !== `eip155:${chainId}`
            || batch.transactionType !== "privacy_deposit" || batch.privacyLeafIndex === null) continue;
          const payload = await this.request<{ encContent: string | null; depositInfo: string | null }>(
            `/transaction/${encodeURIComponent(orgId)}/batches/${encodeURIComponent(batch.id)}/refund-payload`,
          );
          results.push({ org_id: orgId, batch_id: batch.id, leaf_index: batch.privacyLeafIndex,
            address: owner.accounts.find((account) => account.type === "wallet")?.account ?? "",
            chain_id: String(chainId), enc_content: payload.encContent,
            can_refund: batch.privacyRefundable ? 1 : 0,
            is_refunded: batch.transactionStatus === "refunded", deposit_info: payload.depositInfo,
            message_count: batch.items.length });
        }
        if (page * 100 >= rows.total) break;
      }
    }
    return results;
  }

  async messages(chainId: number): Promise<EncryptedAllocation[]> {
    const chain = `eip155:${chainId}`;
    const payroll: EncryptedAllocation[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.request<{
        data: Array<{ id: string; batchId: string; recipient: string | null; tokenAddress: string;
          withdrawData: { caipChainId: string; leafIndex: number | null; tier: number | null;
            privacyDepositLeaf: string | null; content: string | null; encryptedSecret: string | null } | null }>;
        total: number; page: number; pageSize: number;
      }>(`/transaction/my-payroll-items?caipChainId=${chain}&page=${page}&pageSize=100`);
      if (!Array.isArray(result.data) || !Number.isSafeInteger(result.total) || result.page !== page
        || result.pageSize !== 100) throw new Error("Organization payroll item list is invalid");
      payroll.push(...result.data.flatMap((item) => {
        const data = item.withdrawData;
        return item.recipient && data?.caipChainId === chain && data.content && data.encryptedSecret
          && data.privacyDepositLeaf && data.leafIndex !== null && data.tier !== null
          ? [{ id: item.id, batchId: item.batchId, source: "payroll" as const,
            recipient: item.recipient, content: data.content, encryptedSecret: data.encryptedSecret,
            token: item.tokenAddress, tier: data.tier, leafIndex: data.leafIndex,
            depositLeaf: data.privacyDepositLeaf }] : [];
      }));
      if (page * 100 >= result.total) break;
    }
    const defi = await this.request<Array<{ caipChainId: string; leafIndex: number; recipient: string;
      content: string; encryptedSecret: string; token: string; tier: number; depositLeaf: string }>>(
      "/transaction/my-defi-allocations",
    );
    if (!Array.isArray(defi)) throw new Error("Organization DeFi allocation list is invalid");
    return [...payroll, ...defi.filter((row) => row.caipChainId === chain).map((row) => ({
      id: `defi:${chainId}:${row.leafIndex}`, source: "defi" as const, recipient: row.recipient,
      content: row.content, encryptedSecret: row.encryptedSecret, token: row.token,
      tier: row.tier, leafIndex: row.leafIndex, depositLeaf: row.depositLeaf,
    }))];
  }

  depositPath(chainId: number): Promise<{ siblings: string[]; nextIndex: number }> {
    return this.request<{ siblings: string[]; nextIndex: number }>(`/gravarc/deposit-path?caipChainId=eip155:${encodeURIComponent(String(chainId))}`);
  }

  async depositMembership(chainId: number, leafIndex: number): Promise<{
    root: string;
    depositLeaf: string;
    siblings: string[];
    pathIndices: number[];
    leafCount: number;
  }> {
    const row = await this.request<{
      depositRoot: string; depositLeaf: string; siblings: string[]; pathIndices: number[]; leafCount: number;
    }>(`/gravarc/deposit-membership-path?caipChainId=eip155:${encodeURIComponent(String(chainId))}&leafIndex=${encodeURIComponent(String(leafIndex))}`);
    return { root: row.depositRoot, depositLeaf: row.depositLeaf, siblings: row.siblings,
      pathIndices: row.pathIndices, leafCount: row.leafCount };
  }

  saveDeposition(input: {
    leafIndex: number;
    chainId: number;
    blockNumber: number;
    encContent: string | null;
    canRefund: 0 | 1;
    isRefunded: false;
    depositInfo: string;
  }): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/depositions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  saveMessage(input: {
    address: string;
    content: string;
    chainId: number;
    leafIndex: number;
    secretHash: string;
    encPubkey: string;
    clientMessageId: string;
  }): Promise<{ ok: true; id: number }> {
    return this.request<{ ok: true; id: number }>("/messages", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  markDepositionRefunded(chainId: number, leafIndex: number): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("/depositions/refund", {
      method: "PATCH",
      body: JSON.stringify({ chainId, leafIndex, isRefunded: true }),
    });
  }

  confirmPrivacyRefund(orgId: string, batchId: string, txHash: string): Promise<{ status: string; txHash: string }> {
    return this.request(`/transaction/${encodeURIComponent(orgId)}/batches/${encodeURIComponent(batchId)}/confirm-refund-gravarc`, {
      method: "POST", body: JSON.stringify({ depositTxHash: txHash }),
    });
  }

  confirmDefiDeposit(input: {
    caipChainId: string; txHash: string; leafIndex: number; depositLeaf: string;
    withdrawMessages: Array<{ address: string; content: string; secretHash: string; encPubkey: string; clientMessageId: string }>;
  }): Promise<{ success: boolean }> {
    return this.request("/transaction/defi-deposits/confirm", { method: "POST", body: JSON.stringify(input) });
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
    const challenge = await this.challenge(address, family, "privacy-profile-register", registration.payloadHash);
    const signature = await signer.signChallenge(challenge);
    await this.request("/auth/gravarc-user-info", {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({
        address,
        family,
        encryptedSecret: registration.encryptedSecret,
        secretHash: registration.secretHash,
        encPubkey: registration.encPubkey,
        authorization: { nonce: challenge.nonce, signature },
      }),
    });
  }

  joinOrganization(code: string): Promise<{ member: { orgId: string; status: string }; message: string }> {
    return this.request("/orgs/join", {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  organizations(): Promise<Array<{
    organization: { orgId: string; orgName: string };
    member: { status: string; roles: Array<{ role: string }> };
  }>> {
    return this.request("/orgs");
  }

  async apiKeyIdentity(): Promise<ApiKeyIdentity> {
    const [key, owner] = await Promise.all([
      this.request<{
        id: string; name: string; scopes: string[]; userId: string;
        createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
      }>("/api-keys/self"),
      this.me(),
    ]);
    if (key.userId !== owner.user.userId) throw new Error("API key owner does not match Organization user");
    const grants = owner.accounts.filter((account) => account.type === "wallet").map((account) => ({
      family: "evm" as const,
      address: normalizeAddress(account.account, "evm"),
      createdAt: 0,
    }));
    return {
      id: key.id, name: key.name, scopes: key.scopes, grants,
      createdAt: Date.parse(key.createdAt),
      expiresAt: key.expiresAt ? Date.parse(key.expiresAt) : null,
      lastUsedAt: key.lastUsedAt ? Date.parse(key.lastUsedAt) : null,
      revokedAt: null,
    };
  }

  async assertApiKeyGrant(signer: LocalSigner, family: ChainFamily): Promise<ApiKeyIdentity> {
    if (!this.apiKey) throw new Error("PACT_PRIVACY_API_KEY is required");
    const identity = await this.apiKeyIdentity();
    const address = signer.address(family);
    const permitted = identity.grants.some((grant) => (
      grant.family === family && normalizeAddress(grant.address, family) === address
    ));
    if (!permitted) throw new Error(`API key does not grant ${address} (${family})`);
    this.expectedWalletAddress = address;
    return identity;
  }

  async createApiKey(
    signer: LocalSigner,
    family: ChainFamily,
    input: { name: string; scopes: string[]; expiresAt: number | null },
  ): Promise<ApiKeyCreated> {
    const me = await this.me(true);
    if (family !== "evm" || !me.accounts.some((account) => account.type === "wallet"
      && normalizeAddress(account.account, "evm") === signer.address("evm"))) {
      throw new Error("Organization API key wallet does not match the logged-in user");
    }
    const expiresInDays = input.expiresAt === null ? undefined : Math.ceil((input.expiresAt - Date.now()) / 86_400_000);
    if (expiresInDays !== undefined && (expiresInDays < 1 || expiresInDays > 365)) {
      throw new Error("Organization API key validity must be 1–365 days");
    }
    const created = await this.request<{ id: string; plainKey: string; name: string; scopes: string[];
      expiresAt: string | null; createdAt: string }>("/api-keys", {
      authenticated: true,
      method: "POST",
      body: JSON.stringify({ name: input.name, scopes: input.scopes,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}) }),
    });
    return {
      id: created.id, key: created.plainKey, name: created.name, scopes: created.scopes,
      grants: [{ address: signer.address("evm"), family: "evm", createdAt: Date.now() }],
      expiresAt: created.expiresAt ? Date.parse(created.expiresAt) : null,
      createdAt: Date.parse(created.createdAt), lastUsedAt: null, revokedAt: null,
    };
  }

  async rotateApiKey(signer: LocalSigner, family: ChainFamily, id: string): Promise<ApiKeyCreated> {
    await this.assertApiKeyGrant(signer, family);
    const rotated = await this.request<{ id: string; plainKey: string; name: string; scopes: string[];
      expiresAt: string | null; createdAt: string }>(`/api-keys/${encodeURIComponent(id)}/rotate`, {
      authenticated: true,
      method: "POST",
    });
    return {
      id: rotated.id, key: rotated.plainKey, name: rotated.name, scopes: rotated.scopes,
      grants: [{ address: signer.address("evm"), family: "evm", createdAt: Date.now() }],
      expiresAt: rotated.expiresAt ? Date.parse(rotated.expiresAt) : null,
      createdAt: Date.parse(rotated.createdAt), lastUsedAt: null, revokedAt: null,
    };
  }
}
