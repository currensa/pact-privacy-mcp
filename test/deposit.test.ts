import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { PactPrivacyBackend } from "../src/backend/client.js";
import { DepositPayloadStore } from "../src/deposit/payload-store.js";
import { DepositProofService, selectDepositTier } from "../src/deposit/proof.js";
import { readDepositRecipients } from "../src/deposit/prepare.js";
import type { LocalProofService } from "../src/proof/prover.js";
import { conflictingDepositOperation } from "../src/deposit/execute.js";
import { OperationService } from "../src/operations/service.js";
import { OperationStore } from "../src/operations/store.js";

test("selects the smallest supported deposit circuit tier", () => {
  assert.equal(selectDepositTier(1), 8);
  assert.equal(selectDepositTier(8), 8);
  assert.equal(selectDepositTier(9), 16);
  assert.equal(selectDepositTier(128), 128);
  assert.throws(() => selectDepositTier(129), /maximum is 128/);
});

test("parses repeated and CSV payroll recipients", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-payroll-"));
  const csv = resolve(directory, "payroll.csv");
  await writeFile(csv, 'address,amount,note\n"0x0000000000000000000000000000000000000002","2.50","two"\n');
  assert.deepEqual(await readDepositRecipients([
    "0x0000000000000000000000000000000000000001:1.25",
  ], csv), [
    { address: "0x0000000000000000000000000000000000000001", amount: "1.25" },
    { address: "0x0000000000000000000000000000000000000002", amount: "2.50" },
  ]);
});

test("builds deposit circuit inputs locally without exposing them to the backend", async () => {
  let circuitInput: Record<string, unknown> | undefined;
  const backend = {
    async depositPath() { return { siblings: new Array<string>(20).fill("0"), nextIndex: 0 }; },
  } as unknown as PactPrivacyBackend;
  const proofs = {
    async prove(circuit: string, tier: number, input: Record<string, unknown>) {
      assert.equal(circuit, "deposit");
      assert.equal(tier, 8);
      circuitInput = input;
      return {
        pA: ["1", "2"], pB: [["3", "4"], ["5", "6"]], pC: ["7", "8"],
        publicSignals: [], bundleVersion: "11".repeat(32),
      };
    },
  } as unknown as LocalProofService;
  const result = await new DepositProofService(backend, proofs).generate({
    receivers: [{
      address: "0x0000000000000000000000000000000000000001",
      amount: 1_000_000n,
      secretHash: `0x${"00".repeat(31)}01`,
      encPubkey: "00".repeat(31) + "02",
    }],
    token: 0n,
    chainId: 11142220,
    refund: false,
  });
  assert.equal(result.tier, 8);
  assert.equal(result.receivers.length, 1);
  assert.equal(result.receivers[0]?.authPathElements.length, 3);
  assert.equal(result.refundEntries.length, 8);
  assert.deepEqual(result.refundEntries.slice(1), new Array(7).fill(undefined).map(() => ({
    nullifier: `0x${"00".repeat(32)}`,
    secretHash: `0x${"00".repeat(32)}`,
    amount: "0",
  })));
  assert.equal((circuitInput?.commitments as string[]).length, 8);
  assert.equal((circuitInput?.oldFilledSubtrees as string[]).length, 20);
  assert.equal(circuitInput?.canRefund, "0");
});

test("persists only signed transactions and encrypted delivery payloads with private permissions", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-deposit-payload-"));
  const store = new DepositPayloadStore(directory);
  const operationId = "op_abc_0011223344556677";
  await store.saveTransaction(operationId, {
    purpose: "deposit", family: "evm", hash: `0x${"ab".repeat(32)}`, raw: "0xsigned",
  });
  await store.saveDelivery(operationId, {
    predictedLeafIndex: 4,
    deposition: { encContent: "encrypted-refund", canRefund: 1, depositInfo: "{}" },
    messages: [{
      address: "0x0000000000000000000000000000000000000001",
      content: "encrypted-message",
      secretHash: `0x${"11".repeat(32)}`,
      encPubkey: "22".repeat(32),
      clientMessageId: "dp_test:0",
    }],
  });
  const path = resolve(directory, `${operationId}.deposit.json`);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /nullifier|authPathElements|pA|password|privateKey/);
  assert.equal((await store.get(operationId)).delivery?.predictedLeafIndex, 4);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
});

test("blocks another same-chain deposit while a prior transaction or indexing is unresolved", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-deposit-blocker-"));
  const operations = new OperationService(new OperationStore(directory));
  const first = await operations.prepare("deposit", 11142220, { token: "USDC", amount: "10" });
  const second = await operations.prepare("deposit", 11142220, { token: "USDC", amount: "20" });
  await operations.beginExecution(first.id, "deposit");
  const hash = `0x${"ab".repeat(32)}`;
  await operations.registerTransaction(first.id, "deposit", hash);
  await operations.markBroadcast(first.id, hash);
  assert.equal(conflictingDepositOperation(await operations.list(true), second), first.id);

  await operations.recordTransactionStatus(first.id, hash, { state: "confirmed", blockNumber: 42 });
  await operations.transition(first.id, "indexing", ["pending"]);
  assert.equal(conflictingDepositOperation(await operations.list(true), second), first.id);

  await operations.transition(first.id, "delivering", ["indexing"]);
  assert.equal(conflictingDepositOperation(await operations.list(true), second), undefined);
});
