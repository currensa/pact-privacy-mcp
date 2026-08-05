import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { OperationLease } from "../src/operations/lease.js";

test("allows only one executor to advance an operation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-operation-lease-"));
  const lease = new OperationLease(directory);
  const competingProcess = new OperationLease(directory);
  const operationId = "op_abc_0011223344556677";
  let release!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
  const first = lease.run(operationId, async () => blocked);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  await assert.rejects(() => competingProcess.run(operationId, async () => undefined), /already executing/);
  release();
  await first;
  assert.equal(await lease.run(operationId, async () => "done"), "done");
});

test("does not block a different operation", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-operation-lease-"));
  const lease = new OperationLease(directory);
  assert.deepEqual(await Promise.all([
    lease.run("op_abc_0011223344556677", async () => "first"),
    lease.run("op_def_8899aabbccddeeff", async () => "second"),
  ]), ["first", "second"]);
});

test("serializes different deposit operations on the same chain resource", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-operation-lease-"));
  const firstProcess = new OperationLease(directory);
  const secondProcess = new OperationLease(directory);
  let release!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
  const first = firstProcess.runResource("deposit-chain-11142220", async () => blocked);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  await assert.rejects(
    () => secondProcess.runResource("deposit-chain-11142220", async () => undefined),
    /Resource is already executing/,
  );
  release();
  await first;
});
