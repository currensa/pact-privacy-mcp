import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { OperationLease } from "../src/operations/lease.js";
import { OperationService } from "../src/operations/service.js";
import { OperationStore } from "../src/operations/store.js";
import { RelayedDefiExecutionService } from "../src/relayed-defi/execute.js";
import { RelayedDefiPayloadStore } from "../src/relayed-defi/payload-store.js";
import type { PactPrivacyClient } from "../src/runtime/client.js";

test("retries confirmed private re-deposit delivery without calling the relayer again", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-relayed-defi-confirm-"));
  const operations = new OperationService(new OperationStore(directory));
  const plan = {
    allocationId: "defi_1", leafIndex: 1, tier: 8, allocationAmount: "100",
    claimedAtPreparation: "0", nonceAtPreparation: "0",
    inputToken: "0x1111111111111111111111111111111111111111",
    outputToken: "0x2222222222222222222222222222222222222222",
    swapAmount: "90", minimumOutput: "80", defiFee: "10", totalWithdrawal: "100",
    privateRedeposit: true, refund: false,
    protocol: { name: "Kuru", type: "kuru", outputBehavior: "variable",
      address: "0x3333333333333333333333333333333333333333" },
    relayer: "0x4444444444444444444444444444444444444444",
    relayerUrl: "http://localhost:9000", quoteId: "quote", quoteExpiresAt: "2030-01-01T00:00:00.000Z",
    defiRouter: "0x5555555555555555555555555555555555555555",
  };
  let operation = await operations.prepare("relayed-defi", 10143, plan);
  operation = await operations.beginExecution(operation.id, "relayed-defi", operation.planHash);
  const hash = `0x${"aa".repeat(32)}`;
  operation = await operations.registerTransaction(operation.id, "relayed-defi", hash);
  operation = await operations.markBroadcast(operation.id, hash);
  operation = await operations.recordTransactionStatus(operation.id, hash, { state: "confirmed", blockNumber: 10 });
  operation = await operations.transition(operation.id, "indexing", [operation.stage]);
  const payloads = new RelayedDefiPayloadStore(directory);
  await payloads.saveCalldata(operation.id, "0x1234", {
    predictedLeafIndex: 7,
    depositLeaf: "123",
    deposition: { encContent: null, canRefund: 0, depositInfo: "" },
    messages: [],
  });
  let accountChecks = 0;
  let deliveries = 0;
  const client = {
    assertAccount: async () => { accountChecks += 1; return {}; },
    backend: { confirmDefiDeposit: async (input: { submission: string }) => {
      deliveries += 1;
      assert.equal(input.submission, "relayed");
      return { success: true };
    } },
  } as unknown as PactPrivacyClient;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Relayer must not be called after confirmation"); };
  try {
    const service = new RelayedDefiExecutionService(
      client, operations, payloads, new OperationLease(directory), new OperationLease(directory),
    );
    assert.equal((await service.status(operation.id)).stage, "completed");
    assert.equal(accountChecks, 1);
    assert.equal(deliveries, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
