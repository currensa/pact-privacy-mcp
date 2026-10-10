import { randomBytes } from "node:crypto";
import { PactPrivacyBackend } from "../backend/client.js";
import { AccountStore, profileFromEnvironment } from "../accounts/store.js";
import { buildAccountRegistration, decryptOwnSecret, deriveEncryptionKeyPair } from "../crypto/account.js";
import type { ChainFamily } from "../core/types.js";
import { normalizeBackendUrl, type LocalEnvironment } from "../config/env.js";
import { LocalSigner } from "../wallet/local-signer.js";
import type { Prompter } from "./prompts.js";

export type ProvisionedAccount = {
  membership: { orgId: string; status: string };
  environment: LocalEnvironment & Required<Pick<LocalEnvironment, "privateKey" | "backendUrl" | "password" | "apiKey">>;
  families: ChainFamily[];
  addresses: Record<ChainFamily, string | undefined>;
};

function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

export class OnboardingService {
  constructor(private readonly prompt: Prompter, private readonly store = new AccountStore()) {}

  async provision(options: { backendUrl?: string } = {}): Promise<ProvisionedAccount> {
    const backendUrl = options.backendUrl
      ?? await this.prompt.text("Organization backend URL", "http://localhost:3000/api");
    const inviteCode = await this.requireSecret("Organization invite code");
    const families: ChainFamily[] = ["evm"];

    const importExisting = await this.prompt.confirm("Import an existing private key?", false);
    const signer = importExisting
      ? new LocalSigner(await this.requireSecret("Private key"))
      : LocalSigner.generate();

    const password = await this.requireSecret("Account password");
    const confirmation = await this.requireSecret("Confirm account password");
    if (password !== confirmation) throw new Error("Passwords do not match");

    const prior = await this.store.get(signer.address("evm")).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("Account not found:")) return undefined;
      throw error;
    });
    if (prior?.password && prior.password !== password) throw new Error("Use the existing local account password");
    const previousBackendUrl = (await this.store.shared()).backendUrl;
    const sameBackend = !previousBackendUrl || normalizeBackendUrl(previousBackendUrl) === normalizeBackendUrl(backendUrl);
    // Preserve a generated wallet before any request can create an Organization user.
    await this.store.add(profileFromEnvironment({ privateKey: signer.privateKey, backendUrl, password }, families), { merge: true });

    const useSavedKey = Boolean(prior?.apiKey && sameBackend
      && await this.prompt.confirm("Use the saved Organization API key?", true));
    const existingApiKey = useSavedKey ? prior!.apiKey! : await this.prompt.secret("Existing Organization API key (leave blank to create one)");
    const backend = new PactPrivacyBackend(backendUrl, existingApiKey || undefined);
    const addresses: Record<ChainFamily, string | undefined> = { evm: signer.displayAddress("evm"), tron: undefined };
    await backend.authenticate(signer, "evm");
    const joined = await backend.joinOrganization(inviteCode);
    process.stderr.write(`Organization membership: ${joined.member.status}\n`);
    const account = await backend.account("evm");
    if (!account.found) {
      const suppliedSecret = await this.prompt.secret("EVM account secret (leave blank to generate securely)");
      const registration = await buildAccountRegistration(signer, "evm", password, suppliedSecret || generatedSecret());
      await backend.createAccount(signer, "evm", registration);
    } else if (account.encryptedSecret) {
      const pair = await deriveEncryptionKeyPair(password, signer, "evm");
      decryptOwnSecret(account.encryptedSecret, pair.secretKey);
    }

    let apiKey = existingApiKey;
    if (!apiKey) {
      const keyName = await this.prompt.text("API key name", "Pact Privacy MCP");
      const expiryInput = (await this.prompt.text("API key validity in days (or 'never')", "365")).trim().toLowerCase();
      const neverExpires = expiryInput === "never";
      const expiryDays = Number(expiryInput);
      if (!neverExpires && (!Number.isSafeInteger(expiryDays) || expiryDays <= 0)) {
        throw new Error("API key validity must be a positive number of days or 'never'");
      }
      const created = await backend.createApiKey(signer, "evm", {
        name: keyName,
        scopes: ["mcp:read", "mcp:write"],
        expiresAt: neverExpires ? null : Date.now() + expiryDays * 86_400_000,
      });
      apiKey = created.key;
      process.stderr.write("Scoped API key created and authorized.\n");
    } else {
      const identity = await backend.apiKeyIdentity();
      if (!identity.grants.some((grant) => grant.family === "evm" && grant.address === signer.address("evm"))) {
        throw new Error("Existing API key belongs to a different private key");
      }
      if (!identity.scopes.includes("mcp:read") || !identity.scopes.includes("mcp:write")) {
        throw new Error("Existing API key needs mcp:read and mcp:write scopes");
      }
    }

    await this.store.updateApiKey(signer.address("evm"), apiKey);
    await this.store.updateShared({ backendUrl });

    const environment = {
      privateKey: signer.privateKey,
      backendUrl,
      password,
      apiKey,
    };
    return { environment, families, addresses, membership: joined.member };
  }

  private async requireSecret(label: string): Promise<string> {
    const value = await this.prompt.secret(label);
    if (!value) throw new Error(`${label} is required`);
    return value;
  }
}
