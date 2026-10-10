import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type { CanonicalAddress, ChainFamily } from "../core/types.js";
import type { LocalEnvironment } from "../config/env.js";
import { canonicalFromTronAddress, normalizeAddress } from "../chain/address.js";
import { LocalSigner } from "../wallet/local-signer.js";

export type AccountProfile = {
  schemaVersion: 1;
  address: CanonicalAddress;
  privateKey: string;
  password?: string;
  apiKey?: string;
  families: ChainFamily[];
  addresses: Record<ChainFamily, string>;
  createdAt: number;
  updatedAt: number;
};

export type AccountSummary = Pick<AccountProfile, "address" | "families" | "addresses" | "createdAt" | "updatedAt"> & {
  isDefault: boolean;
};

export type SharedConfiguration = {
  schemaVersion: 1;
  defaultAccount?: CanonicalAddress;
  backendUrl?: string;
  tronProApiKey?: string;
  circuitCacheDir?: string;
};

const PROFILE_NAME = /^0x[0-9a-f]{40}\.json$/;

export function defaultConfigDirectory(): string {
  const root = process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config");
  return resolve(root, "pact-privacy", "org");
}

export function defaultDataDirectory(): string {
  const root = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
  return resolve(root, "pact-privacy", "org");
}

export function accountOperationDirectory(address: CanonicalAddress): string {
  return resolve(defaultDataDirectory(), "accounts", address, "operations");
}

export function normalizeAccountAddress(value: string): CanonicalAddress {
  try {
    return normalizeAddress(value, "evm");
  } catch {
    return canonicalFromTronAddress(value);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertPrivate(path: string, kind: "file" | "directory"): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions are too broad; run chmod ${kind === "file" ? "600" : "700"} ${path}`);
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateProfile(value: unknown, expectedAddress?: CanonicalAddress): AccountProfile {
  if (!value || typeof value !== "object") throw new Error("Invalid account profile");
  const profile = value as AccountProfile;
  if (profile.schemaVersion !== 1 || typeof profile.privateKey !== "string" || typeof profile.address !== "string") {
    throw new Error("Invalid account profile");
  }
  const signer = new LocalSigner(profile.privateKey);
  const derived = signer.address("evm");
  if (profile.address !== derived || (expectedAddress && expectedAddress !== derived)) {
    throw new Error(`Account profile address does not match its private key: ${profile.address}`);
  }
  if (!Array.isArray(profile.families) || profile.families.some((family) => family !== "evm" && family !== "tron")) {
    throw new Error(`Account profile has invalid families: ${profile.address}`);
  }
  for (const family of ["evm", "tron"] as const) {
    if (profile.addresses?.[family] !== signer.displayAddress(family)) {
      throw new Error(`Account profile has an invalid ${family} address: ${profile.address}`);
    }
  }
  return profile;
}

export function profileFromEnvironment(
  environment: LocalEnvironment,
  families: ChainFamily[],
  now = Date.now(),
): AccountProfile {
  if (!environment.privateKey) throw new Error("PRIVATE_KEY is required");
  const signer = new LocalSigner(environment.privateKey);
  return {
    schemaVersion: 1,
    address: signer.address("evm"),
    privateKey: signer.privateKey,
    ...(environment.password ? { password: environment.password } : {}),
    ...(environment.apiKey ? { apiKey: environment.apiKey } : {}),
    families: [...new Set(families)],
    addresses: { evm: signer.displayAddress("evm"), tron: signer.displayAddress("tron") },
    createdAt: now,
    updatedAt: now,
  };
}

export class AccountStore {
  readonly directory: string;
  readonly accountsDirectory: string;
  readonly configurationPath: string;

  constructor(directory = defaultConfigDirectory()) {
    this.directory = resolve(directory);
    this.accountsDirectory = resolve(this.directory, "accounts");
    this.configurationPath = resolve(this.directory, "config.json");
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.accountsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await chmod(this.accountsDirectory, 0o700);
  }

  private profilePath(address: CanonicalAddress): string {
    const path = resolve(this.accountsDirectory, `${address}.json`);
    if (!path.startsWith(`${this.accountsDirectory}${sep}`)) throw new Error("Unsafe account profile path");
    return path;
  }

  async shared(): Promise<SharedConfiguration> {
    if (!await exists(this.configurationPath)) return { schemaVersion: 1 };
    await assertPrivate(this.configurationPath, "file");
    const value = JSON.parse(await readFile(this.configurationPath, "utf8")) as SharedConfiguration;
    if (value.schemaVersion !== 1) throw new Error("Unsupported shared configuration schema");
    return value;
  }

  async updateShared(update: Partial<Omit<SharedConfiguration, "schemaVersion">>): Promise<SharedConfiguration> {
    const shared = { ...await this.shared(), ...update, schemaVersion: 1 as const };
    await atomicJson(this.configurationPath, shared);
    return shared;
  }

  async add(profile: AccountProfile, options: { merge?: boolean } = {}): Promise<AccountProfile> {
    await this.ensureDirectories();
    validateProfile(profile, profile.address);
    const path = this.profilePath(profile.address);
    if (await exists(path)) {
      const current = await this.get(profile.address);
      if (current.privateKey !== profile.privateKey) throw new Error(`Account already exists: ${profile.address}`);
      if (!options.merge) throw new Error(`Account already exists: ${profile.address}`);
      const merged: AccountProfile = {
        ...current,
        ...profile,
        families: [...new Set([...current.families, ...profile.families])],
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      };
      await atomicJson(path, merged);
      return merged;
    }
    await atomicJson(path, profile);
    const shared = await this.shared();
    if (!shared.defaultAccount) await this.updateShared({ defaultAccount: profile.address });
    return profile;
  }

  async get(identifier: string): Promise<AccountProfile> {
    const address = normalizeAccountAddress(identifier);
    const path = this.profilePath(address);
    try {
      await assertPrivate(path, "file");
      return validateProfile(JSON.parse(await readFile(path, "utf8")), address);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`Account not found: ${identifier}`);
      throw error;
    }
  }

  async list(): Promise<AccountSummary[]> {
    if (!await exists(this.accountsDirectory)) return [];
    await assertPrivate(this.accountsDirectory, "directory");
    const shared = await this.shared();
    const entries = await readdir(this.accountsDirectory);
    const profiles = await Promise.all(entries.filter((entry) => PROFILE_NAME.test(entry)).map((entry) => this.get(entry.slice(0, -5))));
    return profiles
      .map(({ address, families, addresses, createdAt, updatedAt }) => ({
        address, families, addresses, createdAt, updatedAt, isDefault: shared.defaultAccount === address,
      }))
      .sort((left, right) => left.address.localeCompare(right.address));
  }

  async use(identifier: string): Promise<AccountSummary> {
    const profile = await this.get(identifier);
    await this.updateShared({ defaultAccount: profile.address });
    const { address, families, addresses, createdAt, updatedAt } = profile;
    return { address, families, addresses, createdAt, updatedAt, isDefault: true };
  }

  async updateApiKey(identifier: string, apiKey: string): Promise<void> {
    const profile = await this.get(identifier);
    await atomicJson(this.profilePath(profile.address), { ...profile, apiKey, updatedAt: Date.now() });
  }

  async remove(identifier: string): Promise<void> {
    const profile = await this.get(identifier);
    await rm(this.profilePath(profile.address));
    const shared = await this.shared();
    if (shared.defaultAccount === profile.address) {
      const next = (await this.list())[0]?.address;
      const updated: SharedConfiguration = { ...shared, schemaVersion: 1 };
      if (next) updated.defaultAccount = next;
      else delete updated.defaultAccount;
      await atomicJson(this.configurationPath, updated);
    }
  }
}
