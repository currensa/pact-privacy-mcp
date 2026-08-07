import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PactPrivacyBackend } from "../backend/client.js";
import { buildAccountRegistration } from "../crypto/account.js";
import type { ChainFamily } from "../core/types.js";
import { writeEnvironment, type LocalEnvironment } from "../config/env.js";
import { LocalSigner } from "../wallet/local-signer.js";
import type { Prompter } from "./prompts.js";

export type OnboardingResult = {
  envPath: string;
  families: ChainFamily[];
  addresses: Record<ChainFamily, string | undefined>;
  apiKeyConfigured: boolean;
};

export type ProvisionedAccount = {
  environment: LocalEnvironment & Required<Pick<LocalEnvironment, "privateKey" | "backendUrl" | "password" | "apiKey">>;
  families: ChainFamily[];
  addresses: Record<ChainFamily, string | undefined>;
};

function parseFamilies(value: string): ChainFamily[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "both") return ["evm", "tron"];
  if (normalized === "evm" || normalized === "tron") return [normalized];
  throw new Error("Family must be evm, tron, or both");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function generatedSecret(): string {
  return randomBytes(32).toString("base64url");
}

export class OnboardingService {
  constructor(private readonly prompt: Prompter) {}

  async initialize(options: {
    envPath?: string;
    backendUrl?: string;
    family?: string;
    replace?: boolean;
  } = {}): Promise<OnboardingResult> {
    const envPath = resolve(options.envPath ?? ".env");
    let replace = options.replace ?? false;
    if (await exists(envPath)) {
      replace = replace || await this.prompt.confirm(`${envPath} exists. Update its managed Pact Privacy values?`);
      if (!replace) throw new Error("Onboarding cancelled without changing the environment file");
    }

    const provisioned = await this.provision({
      ...(options.backendUrl ? { backendUrl: options.backendUrl } : {}),
      ...(options.family ? { family: options.family } : {}),
    });
    await writeEnvironment(envPath, provisioned.environment, { replace });

    return { envPath, families: provisioned.families, addresses: provisioned.addresses, apiKeyConfigured: true };
  }

  async provision(options: { backendUrl?: string; family?: string } = {}): Promise<ProvisionedAccount> {
    const backendUrl = options.backendUrl
      ?? await this.prompt.text("Pact Privacy backend URL", "https://privacy.pactpay.app/api");
    const families = parseFamilies(options.family ?? await this.prompt.text("Account family (evm, tron, or both)", "evm"));

    const importExisting = await this.prompt.confirm("Import an existing private key?", false);
    const signer = importExisting
      ? new LocalSigner(await this.requireSecret("Private key"))
      : LocalSigner.generate();

    const password = await this.requireSecret("Account password");
    const confirmation = await this.requireSecret("Confirm account password");
    if (password !== confirmation) throw new Error("Passwords do not match");

    const existingApiKey = await this.prompt.secret("Existing Pact Privacy API key (leave blank to create one)");
    const backend = new PactPrivacyBackend(backendUrl, existingApiKey || undefined);
    const addresses: Record<ChainFamily, string | undefined> = { evm: undefined, tron: undefined };

    for (const family of families) {
      addresses[family] = signer.displayAddress(family);
      process.stderr.write(`Initializing ${family.toUpperCase()} account ${addresses[family]}\n`);
      await backend.authenticate(signer, family);
      const account = await backend.account();
      if (account.found) {
        process.stderr.write(`${family.toUpperCase()} account already exists; it was not modified.\n`);
        continue;
      }
      const suppliedSecret = await this.prompt.secret(
        `${family.toUpperCase()} account secret (leave blank to generate securely)`,
      );
      const registration = await buildAccountRegistration(
        signer,
        family,
        password,
        suppliedSecret || generatedSecret(),
      );
      await backend.createAccount(signer, family, registration);
      process.stderr.write(`${family.toUpperCase()} account initialized.\n`);
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
      const firstFamily = families[0];
      if (!firstFamily) throw new Error("At least one account family is required");
      await backend.authenticate(signer, firstFamily);
      const created = await backend.createApiKey(signer, firstFamily, {
        name: keyName,
        scopes: ["privacy:read", "privacy:write"],
        expiresAt: neverExpires ? null : Date.now() + expiryDays * 86_400_000,
      });
      apiKey = created.key;
      for (const family of families.slice(1)) {
        await backend.authenticate(signer, family);
        await backend.addApiKeyGrant(signer, family, created.id);
      }
      process.stderr.write("Scoped API key created and authorized.\n");
    } else {
      const identity = await backend.apiKeyIdentity();
      const ownerAddress = identity.grants[0]?.address;
      if (!ownerAddress || ownerAddress.toLowerCase() !== signer.address(families[0]!).toLowerCase()) {
        throw new Error("Existing API key belongs to a different private key");
      }
      for (const family of families) {
        if (identity.grants.some(grant => grant.family === family)) continue;
        await backend.authenticate(signer, family);
        await backend.addApiKeyGrant(signer, family, identity.id);
      }
    }

    const environment = {
      privateKey: signer.privateKey,
      backendUrl,
      password,
      apiKey,
    };
    return { environment, families, addresses };
  }

  private async requireSecret(label: string): Promise<string> {
    const value = await this.prompt.secret(label);
    if (!value) throw new Error(`${label} is required`);
    return value;
  }
}
