import assert from "node:assert/strict";
import { test } from "node:test";
import nacl from "tweetnacl";
import { BackendError } from "../src/backend/client.js";
import { decryptMessage } from "../src/crypto/messages.js";
import { deliverRedeposit } from "../src/defi/delivery.js";
import { DepositExecutionService } from "../src/deposit/execute.js";
import type { DepositDelivery } from "../src/deposit/payload-store.js";
import type { DepositPlan } from "../src/deposit/types.js";
import type { DepositProofResult } from "../src/deposit/types.js";
import type { OperationService } from "../src/operations/service.js";
import type { OperationRecord } from "../src/operations/types.js";
import type { PactPrivacyClient } from "../src/runtime/client.js";

test("Organization deposit confirmation retry reuses the same encrypted payload", async () => {
  const calls: unknown[] = [];
  let fail = true;
  let stage: OperationRecord["stage"] = "indexing";
  const backend = {
    confirmPrivacyDeposit: async (_orgId: string, _batchId: string, input: unknown) => {
      calls.push(input);
      if (fail) throw new BackendError(403, "Delivery rejected");
      return { success: true };
    },
  };
  const operations = {
    get: async () => ({ stage }),
    transition: async (_id: string, next: OperationRecord["stage"]) => {
      stage = next;
      return { stage };
    },
  } as unknown as OperationService;
  const service = new DepositExecutionService({ backend } as unknown as PactPrivacyClient, operations);
  const deliver = service as unknown as { saveBackend: (
    operation: OperationRecord, plan: DepositPlan, delivery: DepositDelivery,
    leafIndex: number, txHash: string, timeoutMs: number,
  ) => Promise<void> };
  const operation = { id: "op_test", stage: "indexing" } as OperationRecord;
  const plan = { orgId: "org_1", batchId: "batch_1" } as DepositPlan;
  const delivery: DepositDelivery = { predictedLeafIndex: 7,
    deposition: { encContent: "encrypted", canRefund: 1, depositInfo: "metadata" },
    messages: [{ address: "0x1", content: "encrypted", secretHash: "1", encPubkey: "2", clientMessageId: "batch_1:0" }] };
  const txHash = `0x${"11".repeat(32)}`;
  await assert.rejects(() => deliver.saveBackend(operation, plan, delivery, 8, txHash, 0), /does not match/);
  assert.equal(calls.length, 0);
  await assert.rejects(() => deliver.saveBackend(operation, plan, delivery, 7, txHash, 0), /Delivery rejected/);
  assert.equal(stage, "indexing");
  fail = false;
  await deliver.saveBackend(operation, plan, delivery, 7, txHash, 0);
  assert.equal(stage, "completed");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test("Organization DeFi delivery verifies the leaf and resumes from indexing", async () => {
  let stage: OperationRecord["stage"] = "indexing";
  let calls = 0;
  let fail = true;
  const submissions: string[] = [];
  const client = { backend: { confirmDefiDeposit: async (input: { submission: string }) => {
    calls += 1;
    submissions.push(input.submission);
    if (fail) throw new BackendError(403, "Delivery rejected");
    return { success: true };
  } } } as unknown as PactPrivacyClient;
  const operations = { get: async () => ({ stage }),
    transition: async (_id: string, next: OperationRecord["stage"]) => {
      stage = next;
      return { stage };
    } } as unknown as OperationService;
  const operation = { id: "op_defi", chainId: 10143, kind: "relayed-defi" } as OperationRecord;
  const delivery: DepositDelivery = { predictedLeafIndex: 7, depositLeaf: "123",
    deposition: { encContent: null, canRefund: 0, depositInfo: "" }, messages: [] };
  const txHash = `0x${"22".repeat(32)}`;
  await assert.rejects(() => deliverRedeposit(client, operations, operation, delivery, 8, txHash), /does not match/);
  assert.equal(calls, 0);
  await assert.rejects(() => deliverRedeposit(client, operations, operation, delivery, 7, txHash), /Delivery rejected/);
  assert.equal(stage, "indexing");
  fail = false;
  await deliverRedeposit(client, operations, operation, delivery, 7, txHash);
  assert.equal(stage, "completed");
  assert.equal(calls, 2);
  assert.deepEqual(submissions, ["relayed", "relayed"]);
});

test("Organization deposit ciphertext contains receiver claim data and refundable status slots", async () => {
  const key = nacl.box.keyPair();
  const pubkey = Buffer.from(key.publicKey).toString("hex");
  const address = `0x${"01".repeat(20)}` as `0x${string}`;
  const plan = { batchId: "batch_1", token: `0x${"02".repeat(20)}`, refund: true,
    recipients: [{ memberId: "member_1", address, amount: "20" }] } as DepositPlan;
  const proof: DepositProofResult = { leafIndex: 7, tier: 8, authRoot: "3", depositLeaf: "4", depositorSecretHash: "5",
    proof: { pA: ["", ""], pB: [["", ""], ["", ""]], pC: ["", ""] },
    oldDepositRoot: "0", totalAmount: 20n,
    newDepositRoot: "6", depositPathElements: [], depositPathIndices: [], canRefund: 1,
    receivers: [{ address, nullifier: "7", amount: "20", encPubkey: pubkey,
      authPathElements: [], authPathIndices: [] }],
    refundEntries: Array.from({ length: 8 }, (_, index) => ({ nullifier: String(index + 7),
      secretHash: String(index + 8), amount: index === 0 ? "20" : "0" })) };
  const service = new DepositExecutionService({} as PactPrivacyClient);
  const build = service as unknown as { delivery: (
    plan: DepositPlan, proof: DepositProofResult,
    receivers: Array<{ address: `0x${string}`; amount: bigint; secretHash: string; encPubkey: string }>,
    depositorEncPubkey: string,
  ) => Promise<DepositDelivery> };
  const delivery = await build.delivery(plan, proof,
    [{ address, amount: 20n, secretHash: "8", encPubkey: pubkey }], pubkey);
  const receiver = JSON.parse(decryptMessage(delivery.messages[0]!.content, key.secretKey)) as Record<string, unknown>;
  const depositor = JSON.parse(decryptMessage(delivery.deposition.encContent!, key.secretKey)) as Record<string, unknown>;
  assert.equal(receiver.nullifier, "7");
  assert.equal(receiver.leafIndex, 7);
  assert.deepEqual(depositor.entries, [["member_1"]]);
  assert.equal((depositor.slots as Array<{ withdrawAmount: string }>)[0]?.withdrawAmount, "20");
  assert.equal(depositor.version, 2);
});
