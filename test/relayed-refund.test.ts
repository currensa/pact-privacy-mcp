import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Interface } from "ethers";
import { GRAVARC_REFUND_ABI } from "../src/deposit/abi.js";
import { encodeRelayedRefundCalldata } from "../src/relayed-refund/execute.js";
import { RelayedRefundPayloadStore } from "../src/relayed-refund/payload-store.js";
import { RelayerClient } from "../src/relayer/client.js";

test("encodes public relayed refund calldata with the quoted binding", () => {
  const calldata = encodeRelayedRefundCalldata({
    proof: { pA: ["1", "2"], pB: [["3", "4"], ["5", "6"]], pC: ["7", "8"] },
    depositRoot: 9n,
    nullifierHashes: new Array(8).fill(undefined).map((_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}` as `0x${string}`),
    token: "0x0000000000000000000000000000000000000000",
    refundAmount: 1000n,
    fee: 12n,
    relayer: "0x2222222222222222222222222222222222222222",
    refunder: "0x1111111111111111111111111111111111111111",
    tier: 8,
  });
  const parsed = new Interface(GRAVARC_REFUND_ABI).parseTransaction({ data: calldata });
  assert.equal(parsed?.name, "refund");
  assert.equal(parsed?.args[0].refundAmount, 1000n);
  assert.equal(parsed?.args[0].fee, 12n);
  assert.equal(parsed?.args[0].nullifierHash.length, 8);
  assert.equal(String(parsed?.args[0].relayer).toLowerCase(), "0x2222222222222222222222222222222222222222");
  assert.equal(String(parsed?.args[0].refunder).toLowerCase(), "0x1111111111111111111111111111111111111111");
});

test("persists only public refund calldata and the durable relayer operation ID", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-relayed-refund-"));
  const store = new RelayedRefundPayloadStore(directory);
  const operationId = "op_abc_0011223344556677";
  await store.saveCalldata(operationId, "0x1234");
  await store.saveRelayerOperation(operationId, "123e4567-e89b-12d3-a456-426614174000");
  const path = resolve(directory, `${operationId}.relayed-refund.json`);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /password|rawSecret|depositSecret|witness|privateKey|refundEntries/);
  assert.equal((await store.get(operationId)).relayerOperationId, "123e4567-e89b-12d3-a456-426614174000");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
});

test("uses the relayer refund quote and submission endpoints", async () => {
  const requests: string[] = [];
  const client = new RelayerClient("http://localhost:9000", async (input) => {
    requests.push(String(input));
    if (String(input).endsWith("/quote")) {
      return new Response(JSON.stringify({
        id: "quote-id", operation: "refund", chainId: 1, gravArc: "0x1", relayer: "0x2", token: "0x0",
        amount: "100", tier: 8, networkFee: "1", serviceFee: "1", fee: "2", serviceFeeBps: 10,
        expiresAt: "2030-01-01T00:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "123e4567-e89b-12d3-a456-426614174000", operation: "refund", chainId: 1, state: "queued",
      transactionHash: null, blockNumber: null, error: null, createdAt: "", updatedAt: "",
      submittedAt: null, confirmedAt: null,
    }), { status: 202, headers: { "content-type": "application/json" } });
  });
  const quote = await client.quoteRefund({ chainId: 1, token: "0x0", amount: "100", tier: 8 });
  assert.equal(quote.operation, "refund");
  await client.submitRefund({ chainId: 1, quoteId: quote.id, calldata: "0x1234" });
  assert.deepEqual(requests, ["http://localhost:9000/v1/refund/quote", "http://localhost:9000/v1/refund"]);
});
