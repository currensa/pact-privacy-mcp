import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { AccountStore, accountOperationDirectory, type AccountProfile } from "./store.js";
import { loadEnvironment, type LocalEnvironment } from "../config/env.js";
import { OperationStore } from "../operations/store.js";
import { LocalSigner } from "../wallet/local-signer.js";

export type AccountContext = {
  address: `0x${string}`;
  environment: LocalEnvironment & Required<Pick<LocalEnvironment, "privateKey" | "backendUrl" | "apiKey">>;
  operations: OperationStore;
  source: "profile" | "environment";
  profile?: AccountProfile;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function requireEnvironment(environment: LocalEnvironment): asserts environment is LocalEnvironment & Required<Pick<LocalEnvironment, "privateKey" | "backendUrl" | "apiKey">> {
  if (!environment.privateKey || !environment.backendUrl || !environment.apiKey) {
    throw new Error("Private key, backend URL, and API key are required");
  }
}

export async function resolveAccountContext(options: {
  account?: string;
  envPath?: string;
  store?: AccountStore;
  legacyPath?: string;
} = {}): Promise<AccountContext> {
  if (options.envPath) {
    const environment = await loadEnvironment(resolve(options.envPath), { requireComplete: true, checkPermissions: true });
    requireEnvironment(environment);
    const address = new LocalSigner(environment.privateKey).address("evm");
    return { address, environment, operations: new OperationStore(), source: "environment" };
  }

  const store = options.store ?? new AccountStore();
  const shared = await store.shared();
  const selected = options.account ?? process.env.PACT_PRIVACY_ACCOUNT ?? shared.defaultAccount;
  if (selected) {
    const profile = await store.get(selected);
    const environment: LocalEnvironment = {
      privateKey: profile.privateKey,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      ...(profile.password ? { password: profile.password } : {}),
      ...(shared.backendUrl ? { backendUrl: shared.backendUrl } : {}),
      ...(shared.tronProApiKey ? { tronProApiKey: shared.tronProApiKey } : {}),
      ...(shared.circuitCacheDir ? { circuitCacheDir: shared.circuitCacheDir } : {}),
    };
    requireEnvironment(environment);
    return {
      address: profile.address,
      environment,
      operations: new OperationStore(accountOperationDirectory(profile.address)),
      source: "profile",
      profile,
    };
  }

  const legacyPath = resolve(options.legacyPath ?? ".env");
  if (await exists(legacyPath)) {
    const environment = await loadEnvironment(legacyPath, { requireComplete: true, checkPermissions: true });
    requireEnvironment(environment);
    const address = new LocalSigner(environment.privateKey).address("evm");
    return { address, environment, operations: new OperationStore(), source: "environment" };
  }
  throw new Error("No account is configured; run `pactpay account add` or `pactpay account migrate`");
}
