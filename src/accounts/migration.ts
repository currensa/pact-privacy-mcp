import { chmod, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { PactPrivacyBackend } from "../backend/client.js";
import { loadEnvironment } from "../config/env.js";
import type { ChainFamily } from "../core/types.js";
import { legacyOperationDirectory } from "../operations/store.js";
import type { OperationRecord } from "../operations/types.js";
import { LocalSigner } from "../wallet/local-signer.js";
import { AccountStore, accountOperationDirectory, normalizeAccountAddress, profileFromEnvironment } from "./store.js";

export type MigrationResult = {
  address: `0x${string}`;
  movedOperations: string[];
  ambiguousOperations: string[];
  envPath: string;
};

async function persistThenRemove(sourcePath: string, destinationPath: string, payload: string): Promise<"moved" | "conflict"> {
  try {
    const handle = await open(destinationPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rm(sourcePath);
    return "moved";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (await readFile(destinationPath, "utf8") !== payload) return "conflict";
    await rm(sourcePath);
    return "moved";
  }
}

export async function migrateLegacyOperations(
  source: string,
  destination: string,
  address: `0x${string}`,
): Promise<Pick<MigrationResult, "movedOperations" | "ambiguousOperations">> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  let entries: string[] = [];
  try {
    entries = await readdir(source);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const movedOperations: string[] = [];
  const ambiguousOperations: string[] = [];
  for (const entry of entries.filter((name) => /^op_[a-z0-9]+_[a-f0-9]{16}\.json$/.test(name))) {
    const sourcePath = resolve(source, entry);
    const record = JSON.parse(await readFile(sourcePath, "utf8")) as OperationRecord;
    if (record.accountAddress && record.accountAddress !== address) {
      ambiguousOperations.push(record.id);
      continue;
    }
    record.schemaVersion = 2;
    record.accountAddress = address;
    const destinationPath = resolve(destination, entry);
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    if (await persistThenRemove(sourcePath, destinationPath, payload) === "moved") {
      movedOperations.push(record.id);
    } else ambiguousOperations.push(record.id);
  }

  const remaining = await readdir(source).catch(() => [] as string[]);
  for (const entry of remaining.filter((name) => /^op_[a-z0-9]+_[a-f0-9]{16}\.(?:deposit|withdraw|refund)\.json$/.test(name))) {
    const operationId = entry.split(".")[0]!;
    if (ambiguousOperations.includes(operationId)) continue;
    let owner: OperationRecord;
    try {
      owner = JSON.parse(await readFile(resolve(destination, `${operationId}.json`), "utf8")) as OperationRecord;
    } catch {
      ambiguousOperations.push(operationId);
      continue;
    }
    if (owner.accountAddress !== address) {
      ambiguousOperations.push(operationId);
      continue;
    }
    const sourcePath = resolve(source, entry);
    const payload = await readFile(sourcePath, "utf8");
    if (await persistThenRemove(sourcePath, resolve(destination, entry), payload) === "conflict") {
      ambiguousOperations.push(operationId);
    }
  }
  return { movedOperations, ambiguousOperations: [...new Set(ambiguousOperations)] };
}

export async function migrateLegacyAccount(
  envPath: string,
  store = new AccountStore(),
): Promise<MigrationResult> {
  const absoluteEnv = resolve(envPath);
  const environment = await loadEnvironment(absoluteEnv, { requireComplete: true, checkPermissions: true });
  const signer = new LocalSigner(environment.privateKey!);
  const backend = new PactPrivacyBackend(environment.backendUrl!, environment.apiKey);
  const identity = await backend.apiKeyIdentity();
  const address = signer.address("evm");
  const families = identity.grants
    .filter((grant) => normalizeAccountAddress(grant.address) === address)
    .map((grant) => grant.family) as ChainFamily[];
  if (families.length === 0) throw new Error("The configured API key has no grant for this account");

  await store.add(profileFromEnvironment(environment, families), { merge: true });
  await store.updateShared({
    defaultAccount: address,
    backendUrl: environment.backendUrl!,
    ...(environment.tronProApiKey ? { tronProApiKey: environment.tronProApiKey } : {}),
    ...(environment.circuitCacheDir ? { circuitCacheDir: environment.circuitCacheDir } : {}),
  });

  const { movedOperations, ambiguousOperations } = await migrateLegacyOperations(
    legacyOperationDirectory(),
    accountOperationDirectory(address),
    address,
  );
  return { address, movedOperations, ambiguousOperations, envPath: absoluteEnv };
}
