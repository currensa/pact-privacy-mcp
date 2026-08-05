import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { operationPlanHash } from "../src/operations/plan.js";
import { OperationService } from "../src/operations/service.js";
import { OperationStore } from "../src/operations/store.js";

async function setup(now = 1_800_000_000_000) {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-operations-"));
  let currentTime = now;
  const service = new OperationService(new OperationStore(directory), () => currentTime);
  return { directory, service, setTime(value: number) { currentTime = value; } };
}

test("canonical plan hashes ignore object key order and reject sensitive fields", () => {
  assert.equal(
    operationPlanHash({ chainId: 1, recipients: [{ address: "0x1", amount: "10" }] }),
    operationPlanHash({ recipients: [{ amount: "10", address: "0x1" }], chainId: 1 }),
  );
  assert.throws(() => operationPlanHash({ password: "must-not-persist" }), /sensitive field/);
  assert.throws(() => operationPlanHash({ amount: 1.5 }), /unsafe number/);
});

test("prepares immutable, private operation files and expires unused plans", async () => {
  const context = await setup();
  const operation = await context.service.prepare("deposit", 11142220, {
    token: "USDC",
    totalAmount: "1000000",
    recipients: [{ address: "0x0000000000000000000000000000000000000001", amount: "1000000" }],
  }, 1_000);
  operation.plan.token = "MUTATED";

  assert.equal((await context.service.get(operation.id)).plan.token, "USDC");
  if (process.platform !== "win32") {
    assert.equal((await stat(resolve(context.directory, `${operation.id}.json`))).mode & 0o077, 0);
  }

  context.setTime(operation.expiresAt);
  assert.equal((await context.service.get(operation.id)).stage, "expired");
  await assert.rejects(() => context.service.cancel(operation.id), /prepared operation/);
});

test("persists transaction hashes before broadcast and never treats not-found as retryable", async () => {
  const context = await setup();
  const prepared = await context.service.prepare("withdraw", 11142220, { allocationId: 7, amount: "10" });
  await context.service.beginExecution(prepared.id, "withdraw", prepared.planHash);
  const hash = `0x${"ab".repeat(32)}`;
  await context.service.registerTransaction(prepared.id, "withdraw", hash);
  await assert.rejects(() => context.service.cancel(prepared.id), /prepared operation/);

  const registered = await context.service.get(prepared.id);
  assert.equal(registered.transactions[0]?.state, "registered");
  assert.equal(registered.transactions[0]?.broadcastAt, undefined);

  await context.service.markBroadcast(prepared.id, hash);
  const uncertain = await context.service.reconcile(prepared.id, async () => ({ state: "not_found" }));
  assert.equal(uncertain.transactions[0]?.state, "unknown");
  assert.equal(uncertain.stage, "pending");

  const confirmed = await context.service.reconcile(prepared.id, async () => ({ state: "confirmed", blockNumber: 42 }));
  assert.equal(confirmed.transactions[0]?.state, "confirmed");
  assert.equal(confirmed.transactions[0]?.blockNumber, 42);
});

test("serializes concurrent operation updates without losing transaction hashes", async () => {
  const context = await setup();
  const prepared = await context.service.prepare("deposit", 3448148188, { token: "USDT", amount: "10" });
  await context.service.beginExecution(prepared.id, "deposit");
  await Promise.all([
    context.service.registerTransaction(prepared.id, "approval", "11".repeat(32)),
    context.service.registerTransaction(prepared.id, "deposit", "22".repeat(32)),
  ]);
  const operation = await context.service.get(prepared.id);
  assert.deepEqual(operation.transactions.map(({ purpose }) => purpose).sort(), ["approval", "deposit"]);
  assert.equal(operation.revision, 3);
});

test("restores the safe stage after a local resumable failure", async () => {
  const context = await setup();
  const prepared = await context.service.prepare("deposit", 11142220, { token: "USDC", amount: "10" });
  await context.service.beginExecution(prepared.id, "deposit");
  const failed = await context.service.fail(prepared.id, new Error("proof worker stopped"));
  assert.equal(failed.stage, "failed");
  assert.equal(failed.resumeStage, "proving");
  const resumed = await context.service.retryFailed(prepared.id);
  assert.equal(resumed.stage, "proving");
  assert.equal(resumed.error, undefined);
});
