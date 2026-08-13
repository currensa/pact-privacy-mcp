import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Interface } from "ethers";
import { GRAVARC_WITHDRAW_ABI } from "../src/deposit/abi.js";
import { encodeRelayedWithdrawCalldata } from "../src/relayed-withdraw/execute.js";
import { RelayedWithdrawPayloadStore } from "../src/relayed-withdraw/payload-store.js";
import { RelayerClient, RelayerHttpError } from "../src/relayer/client.js";

test("encodes public relayed withdrawal calldata with the quoted binding", () => {
  const calldata = encodeRelayedWithdrawCalldata({
    proof: { pA: ["1", "2"], pB: [["3", "4"], ["5", "6"]], pC: ["7", "8"] },
    nullifierHash: `0x${"aa".repeat(32)}`,
    depositRoot: 9n,
    claimedAmount: 10n,
    expectedAmount: 1000n,
    fee: 12n,
    relayer: "0x2222222222222222222222222222222222222222",
    recipient: "0x1111111111111111111111111111111111111111",
    nonce: 3n,
    token: "0x0000000000000000000000000000000000000000",
    tier: 8,
  });
  const parsed = new Interface(GRAVARC_WITHDRAW_ABI).parseTransaction({ data: calldata });
  assert.equal(parsed?.name, "withdraw");
  assert.equal(parsed?.args[0].fee, 12n);
  assert.equal(String(parsed?.args[0].relayer).toLowerCase(), "0x2222222222222222222222222222222222222222");
  assert.equal(String(parsed?.args[0].recipient).toLowerCase(), "0x1111111111111111111111111111111111111111");
});

test("persists only public calldata and the durable relayer operation ID", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-relayed-withdraw-"));
  const store = new RelayedWithdrawPayloadStore(directory);
  const operationId = "op_abc_0011223344556677";
  await store.saveCalldata(operationId, "0x1234");
  await store.saveRelayerOperation(operationId, "123e4567-e89b-12d3-a456-426614174000");
  const path = resolve(directory, `${operationId}.relayed-withdraw.json`);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /password|rawSecret|witness|privateKey|allocationInfo/);
  assert.equal((await store.get(operationId)).relayerOperationId, "123e4567-e89b-12d3-a456-426614174000");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
});

test("requests a quote and reports structured relayer failures", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const client = new RelayerClient("http://localhost:9000/", async (input, init) => {
    requests.push({ url: String(input), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return new Response(JSON.stringify({
      id: "quote-id", chainId: 1, gravArc: "0x1", relayer: "0x2", token: "0x0", amount: "100",
      tier: 8, networkFee: "1", serviceFee: "1", fee: "2", serviceFeeBps: 10,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const quote = await client.quoteWithdraw({ chainId: 1, token: "0x0", amount: "100", tier: 8 });
  assert.equal(quote.fee, "2");
  assert.equal(requests[0]?.url, "http://localhost:9000/v1/withdraw/quote");

  const failing = new RelayerClient("http://localhost:9000", async () => new Response(JSON.stringify({
    error: { code: "QUOTE_MISMATCH", message: "Quote mismatch" },
  }), { status: 409, headers: { "content-type": "application/json" } }));
  await assert.rejects(() => failing.operation("id"), (error: unknown) => (
    error instanceof RelayerHttpError && error.status === 409 && error.code === "QUOTE_MISMATCH"
  ));
});
