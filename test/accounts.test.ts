import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { AccountStore, normalizeAccountAddress, profileFromEnvironment } from "../src/accounts/store.js";
import { resolveAccountContext } from "../src/accounts/context.js";
import { migrateLegacyOperations } from "../src/accounts/migration.js";
import { OperationService } from "../src/operations/service.js";
import { OperationStore } from "../src/operations/store.js";
import { LocalSigner } from "../src/wallet/local-signer.js";

const BACKEND = "https://privacy.pactpay.app/api";

function environment(privateKey: string, suffix: string) {
  return { privateKey, backendUrl: BACKEND, password: `password-${suffix}`, apiKey: `api-${suffix}` };
}

test("stores protected profiles and resolves EVM, canonical, and TRON identifiers", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-accounts-"));
  const store = new AccountStore(directory);
  const signer = LocalSigner.generate();
  const profile = profileFromEnvironment(environment(signer.privateKey, "one"), ["evm", "tron"], 100);
  await store.add(profile);

  assert.equal((await store.get(signer.displayAddress("evm"))).address, profile.address);
  assert.equal((await store.get(signer.displayAddress("tron"))).address, profile.address);
  assert.equal(normalizeAccountAddress(signer.displayAddress("tron")), profile.address);
  await assert.rejects(() => store.add(profile), /already exists/);
  assert.equal((await store.list())[0]?.isDefault, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(resolve(directory, "accounts", `${profile.address}.json`))).mode & 0o077, 0);
    assert.equal((await stat(resolve(directory, "accounts"))).mode & 0o077, 0);
  }
  assert.doesNotMatch(JSON.stringify(await store.list()), /privateKey|password|api-one/);
});

test("selects an explicit account before the saved default", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-context-"));
  const store = new AccountStore(directory);
  const first = profileFromEnvironment(environment(LocalSigner.generate().privateKey, "first"), ["evm"]);
  const second = profileFromEnvironment(environment(LocalSigner.generate().privateKey, "second"), ["tron"]);
  await store.add(first);
  await store.add(second);
  await store.updateShared({ backendUrl: BACKEND, defaultAccount: first.address });

  assert.equal((await resolveAccountContext({ store })).address, first.address);
  assert.equal((await resolveAccountContext({ store, account: second.address })).address, second.address);
});

test("binds operations to an account and rejects another signer", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-account-operations-"));
  const first = LocalSigner.generate().address("evm");
  const second = LocalSigner.generate().address("evm");
  const store = new OperationStore(directory);
  const operation = await new OperationService(store, Date.now, first).prepare("deposit", 1, { amount: "1" });
  assert.equal(operation.schemaVersion, 2);
  assert.equal(operation.accountAddress, first);
  await assert.rejects(() => new OperationService(store, Date.now, second).get(operation.id), /belongs to account/);
});

test("moves legacy operations into an account directory and is idempotent", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pact-migration-"));
  const source = resolve(root, "operations");
  const destination = resolve(root, "accounts", "operations");
  const legacy = new OperationService(new OperationStore(source));
  const operation = await legacy.prepare("refund", 1, { leafIndex: 2 });
  await writeFile(resolve(source, `${operation.id}.refund.json`), JSON.stringify({
    schemaVersion: 1, operationId: operation.id, transaction: { hash: "ab".repeat(32) },
  }), { mode: 0o600 });
  const address = LocalSigner.generate().address("evm");

  assert.deepEqual(await migrateLegacyOperations(source, destination, address), {
    movedOperations: [operation.id], ambiguousOperations: [],
  });
  const migrated = JSON.parse(await readFile(resolve(destination, `${operation.id}.json`), "utf8")) as {
    schemaVersion: number; accountAddress: string;
  };
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.accountAddress, address);
  assert.equal(JSON.parse(await readFile(resolve(destination, `${operation.id}.refund.json`), "utf8")).operationId, operation.id);
  assert.deepEqual(await migrateLegacyOperations(source, destination, address), {
    movedOperations: [], ambiguousOperations: [],
  });
});
