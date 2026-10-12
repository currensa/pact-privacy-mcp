import assert from "node:assert/strict";
import { test } from "node:test";
import { PactPrivacyBackend } from "../src/backend/client.js";
import { parseWithdrawMessage } from "../src/discovery/service.js";
import { parseRefundContent } from "../src/refund/content.js";

const address = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";

test("Organization private-data reads retain opaque payroll IDs and exclude incomplete items", async () => {
  const calls: string[] = [];
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith("my-payroll-items")) return Response.json({
      data: [
        { id: "payroll_opaque", batchId: "batch_opaque", recipient: address, tokenAddress: token,
          withdrawData: { caipChainId: "eip155:10143", leafIndex: 3, tier: 8, privacyDepositLeaf: "123",
            content: "ciphertext", encryptedSecret: "secretbox" } },
        { id: "pending", batchId: "pending_batch", recipient: address, tokenAddress: token, withdrawData: null },
      ], total: 2, page: 1, pageSize: 100,
    });
    if (path.endsWith("my-defi-allocations")) return Response.json([{ caipChainId: "eip155:10143",
      leafIndex: 4, recipient: address, content: "ciphertext2", encryptedSecret: "secretbox",
      token, tier: 8, depositLeaf: "456" }]);
    throw new Error(`Unexpected route: ${path}`);
  });
  const allocations = await backend.messages(10143);
  assert.deepEqual(allocations.map(({ id, source }) => ({ id, source })), [
    { id: "payroll_opaque", source: "payroll" }, { id: "defi:10143:4", source: "defi" },
  ]);
  assert.deepEqual(calls, ["/api/transaction/my-payroll-items", "/api/transaction/my-defi-allocations"]);
});

test("Organization depositor reads include only creator-owned indexed batches", async () => {
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("auth/me")) return Response.json({ user: { userId: "owner" },
      accounts: [{ type: "wallet", account: address }] });
    if (path.endsWith("orgs")) return Response.json([{ organization: { orgId: "org_1", orgName: "Org" },
      member: { status: "active", roles: [{ role: "Owner" }] } }]);
    if (path.endsWith("transaction/org_1")) return Response.json({ data: [
      { id: "batch_1", createdBy: "owner", caipChainId: "eip155:10143", transactionType: "privacy_deposit",
        transactionStatus: "success", privacyRefundable: true, privacyLeafIndex: 3, items: [{}] },
      { id: "batch_other", createdBy: "other", caipChainId: "eip155:10143", transactionType: "privacy_deposit",
        transactionStatus: "success", privacyRefundable: true, privacyLeafIndex: 4, items: [{}] },
    ], total: 2, page: 1, pageSize: 100 });
    if (path.endsWith("refund-payload")) return Response.json({ encContent: "ciphertext", depositInfo: "metadata" });
    throw new Error(`Unexpected route: ${path}`);
  });
  const rows = await backend.depositions(10143);
  assert.deepEqual(rows.map(({ org_id, batch_id, leaf_index }) => ({ org_id, batch_id, leaf_index })), [
    { org_id: "org_1", batch_id: "batch_1", leaf_index: 3 },
  ]);
});

test("Organization ciphertext metadata is bound to its indexed allocation", () => {
  const envelope = { id: "item_1", source: "payroll" as const, recipient: address,
    content: "ciphertext", encryptedSecret: "secretbox", token, tier: 8, leafIndex: 3, depositLeaf: "123" };
  const payload = { nullifier: "1", amount: "20", authRoot: "3", depositorSecretHash: "4",
    authPathElements: [], authPathIndices: [] };
  assert.equal(parseWithdrawMessage(JSON.stringify(payload), envelope).token, token);
  assert.throws(() => parseWithdrawMessage(JSON.stringify({ ...payload, leafIndex: 4 }), envelope), /does not match/);
});

test("Organization refundable status slots map to the Core proof input shape", () => {
  const slots = Array.from({ length: 8 }, (_, index) => ({
    nullifier: String(index + 1), secretHash: String(index + 2), withdrawAmount: index === 0 ? "20" : "0",
  }));
  const content = parseRefundContent(JSON.stringify({ version: 2, batchId: "batch_1", leafIndex: 3,
    token, tier: 8, authRoot: "1", depositLeaf: "2", depositorSecretHash: "3", slots }));
  assert.equal(content.refundEntries[0]?.amount, "20");
  assert.equal(content.batchId, "batch_1");
});

test("Organization receipt confirmation uses batch, item, and DeFi routes", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) as unknown });
    return Response.json({ success: true, status: "receipt_verified", txHash: `0x${"11".repeat(32)}` });
  });
  const txHash = `0x${"11".repeat(32)}`;
  await backend.confirmPrivacyDeposit("org_1", "batch_1", {
    depositTxHash: txHash, withdrawMessages: [], encContent: "ciphertext", depositInfo: "metadata",
    clientRefundId: "batch_1:tx",
  });
  await backend.confirmPrivacyWithdraw("item_1", txHash);
  await backend.confirmPrivacyRefund("org_1", "batch_1", txHash);
  await backend.confirmDefiDeposit({ submission: "relayed", caipChainId: "eip155:10143", txHash,
    leafIndex: 3, depositLeaf: "123", withdrawMessages: [] });
  assert.deepEqual(requests.map(({ path }) => path), [
    "/api/transaction/org_1/batches/batch_1/confirm-deposit",
    "/api/transaction/my-payroll-items/item_1/confirm-withdraw",
    "/api/transaction/org_1/batches/batch_1/confirm-refund-gravarc",
    "/api/transaction/defi-deposits/confirm",
  ]);
  assert.deepEqual(requests[1]?.body, { txHash });
});

test("Organization member discovery follows pagination and excludes unregistered members", async () => {
  const calls: string[] = [];
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/members")) {
      const page = Number(url.searchParams.get("page"));
      return Response.json({
        data: page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ memberId: `member_${index}`, gravArcAddress: `0x${(index + 1).toString(16).padStart(40, "0")}` }))
          : [{ memberId: "member_100", gravArcAddress: null }],
        total: 101, page, pageSize: 100,
      });
    }
    if (url.pathname.endsWith("recipient-profiles")) {
      const addresses = url.searchParams.get("addresses")!.split(",");
      return Response.json(addresses.map((memberAddress) => ({ address: memberAddress,
        secretHash: `0x${"01".repeat(32)}`, encPubkey: `0x${"02".repeat(32)}` })));
    }
    throw new Error(`Unexpected route: ${url.pathname}`);
  });
  const members = await backend.users("evm", "org_1");
  assert.equal(members.length, 100);
  assert.equal(members[0]?.memberId, "member_0");
  assert.equal(members[99]?.memberId, "member_99");
  assert.equal(calls.filter((call) => call.includes("/members?")).length, 2);
});

test("Organization private-data reads fail closed on authorization denial", async () => {
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async () =>
    Response.json({ message: "Forbidden" }, { status: 403 }));
  await assert.rejects(() => backend.users("evm", "other_org"), /Forbidden/);
  await assert.rejects(() => backend.messages(10143), /Forbidden/);
  await assert.rejects(() => backend.depositions(10143), /Forbidden/);
});
