import assert from "node:assert/strict";
import { test } from "node:test";
import { PactPrivacyBackend } from "../src/backend/client.js";
import { LocalSigner } from "../src/wallet/local-signer.js";
import { PactPrivacyClient } from "../src/runtime/client.js";

const network = {
  caipChainId: "eip155:10143",
  chainId: 10143,
  chainName: "Monad Testnet",
  family: "evm",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://rpc.example"],
  blockExplorerUrls: ["https://explorer.example"],
  contracts: {
    gravArc: "0x0000000000000000000000000000000000000001",
    pureRouter: "0x0000000000000000000000000000000000000002",
    defiRouter: "0x0000000000000000000000000000000000000003",
  },
  tokens: [{ symbol: "MCK", name: "Mock", address: "0x0000000000000000000000000000000000000004", decimals: 18, isStable: false }],
  protocols: [{ name: "Kuru", address: "0x0000000000000000000000000000000000000005", outputBehavior: "variable" }],
  capabilities: { deposit: true, withdraw: true, refund: true, defi: true },
};

test("Organization network catalog supplies MCP chains and contract details", async () => {
  const calls: string[] = [];
  const backend = new PactPrivacyBackend("https://org.example/api", undefined, async (input) => {
    calls.push(String(input));
    return Response.json([network]);
  });
  assert.deepEqual((await backend.chains()).map(({ chainId, family }) => ({ chainId, family })), [
    { chainId: 10143, family: "evm" },
  ]);
  const selected = await backend.chain(10143);
  assert.equal(selected.gravArc, network.contracts.gravArc);
  assert.equal(selected.pactPrivacyDefiRouter, network.contracts.defiRouter);
  assert.equal(selected.defiProtocols[0]?.name, "Kuru");
  assert.deepEqual(calls, ["https://org.example/api/chain-asset/networks", "https://org.example/api/chain-asset/networks"]);
  await assert.rejects(() => backend.chain(11155111), /Unsupported chain/);
});
test("Organization network mapping rejects mismatched CAIP identity", async () => {
  const backend = new PactPrivacyBackend("https://org.example", undefined, async () => Response.json([
    { ...network, caipChainId: "eip155:11155111" },
  ]));
  await assert.rejects(() => backend.chains(), /network response is invalid/);
});

test("Organization path routes preserve proof-verification fields", async () => {
  const paths: string[] = [];
  const backend = new PactPrivacyBackend("https://org.example", undefined, async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    paths.push(`${path}${url.search}`);
    return Response.json(path.endsWith("deposit-path")
      ? { nextIndex: 2, siblings: ["0"], pathIndices: [0] }
      : { leafIndex: 1, leafCount: 2, depositLeaf: "123", depositRoot: "456", siblings: ["0"], pathIndices: [1] });
  });
  assert.equal((await backend.depositPath(10143)).nextIndex, 2);
  assert.deepEqual(await backend.depositMembership(10143, 1), {
    root: "456", depositLeaf: "123", leafCount: 2, siblings: ["0"], pathIndices: [1],
  });
  assert.deepEqual(paths, [
    "/api/gravarc/deposit-path?caipChainId=eip155:10143",
    "/api/gravarc/deposit-membership-path?caipChainId=eip155:10143&leafIndex=1",
  ]);
});

test("Organization wallet login and scoped key identity use separate credentials", async () => {
  const signer = new LocalSigner(`0x${"11".repeat(32)}`);
  const calls: Array<{ path: string; authorization: string | null; key: string | null }> = [];
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    calls.push({ path, authorization: headers.get("authorization"), key: headers.get("x-api-key") });
    if (path.endsWith("wallet/challenge")) return Response.json({
      nonce: `0x${"22".repeat(32)}`, expiresAt: Date.now() + 60_000, action: "login",
      payloadHash: `0x${"00".repeat(32)}`, family: "evm", domain: { name: "PactPay", version: "1" },
    });
    if (path.endsWith("auth/login")) return Response.json({ userId: "u1", token: "session" });
    if (path.endsWith("auth/me")) return Response.json({
      user: { userId: "u1" }, accounts: [{ type: "wallet", account: signer.displayAddress("evm") }],
    });
    if (path.endsWith("api-keys/self")) return Response.json({
      id: "key_1", name: "MCP", scopes: ["mcp:read", "mcp:write"], userId: "u1",
      createdAt: new Date().toISOString(), expiresAt: null, lastUsedAt: null,
    });
    if (path.endsWith("gravarc-user-info/detail")) return Response.json({
      address: signer.displayAddress("evm"), encryptedSecret: "ciphertext", secretHash: `0x${"33".repeat(32)}`,
      encPubkey: "44".repeat(32),
    });
    throw new Error(`Unexpected path: ${path}`);
  });
  await backend.authenticate(signer, "evm");
  const identity = await backend.assertApiKeyGrant(signer, "evm");
  assert.equal(identity.grants[0]?.address, signer.address("evm"));
  assert.equal((await backend.account()).found, true);
  assert.equal(calls.find((call) => call.path.endsWith("auth/me"))?.authorization, "Bearer session");
  assert.equal(calls.find((call) => call.path.endsWith("api-keys/self"))?.key, "test-key");
});

test("Organization login refuses a session bound to another wallet", async () => {
  const signer = new LocalSigner(`0x${"11".repeat(32)}`);
  const other = new LocalSigner(`0x${"12".repeat(32)}`);
  const backend = new PactPrivacyBackend("https://org.example", undefined, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("wallet/challenge")) return Response.json({
      nonce: `0x${"22".repeat(32)}`, expiresAt: Date.now() + 60_000, action: "login",
      payloadHash: `0x${"00".repeat(32)}`, family: "evm", domain: { name: "PactPay", version: "1" },
    });
    if (path.endsWith("auth/login")) return Response.json({ userId: "user_1", token: "session" });
    if (path.endsWith("auth/me")) return Response.json({ user: { userId: "user_1" },
      accounts: [{ type: "wallet", account: other.displayAddress("evm") }] });
    throw new Error(`Unexpected path: ${path}`);
  });
  await assert.rejects(() => backend.authenticate(signer, "evm"), /does not match the local private key/);
});

test("Organization recipients are limited to active members with current privacy profiles", async () => {
  const address = "0x0000000000000000000000000000000000000001";
  const backend = new PactPrivacyBackend("https://org.example", "test-key", async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/members")) {
      assert.equal(url.searchParams.get("status"), "active");
      return Response.json({ data: [{ memberId: "member_1", gravArcAddress: address },
        { memberId: "member_2", gravArcAddress: null }], total: 2, page: 1, pageSize: 100 });
    }
    if (url.pathname.endsWith("recipient-profiles")) {
      assert.equal(url.searchParams.get("addresses"), address);
      return Response.json([{ address, secretHash: `0x${"11".repeat(32)}`, encPubkey: "22".repeat(32) }]);
    }
    throw new Error(`Unexpected path: ${url.pathname}`);
  });
  assert.deepEqual((await backend.users("evm", "org_1")).map(({ memberId }) => memberId), ["member_1"]);
  await assert.rejects(() => backend.users("evm", ""), /Organization ID is required/);
});

test("Organization account authorization is revalidated at each workflow entry", async () => {
  const client = new PactPrivacyClient({
    privateKey: `0x${"11".repeat(32)}`, backendUrl: "https://org.example", apiKey: "test-key",
  });
  let checks = 0;
  client.chain = async () => ({ config: { family: "evm" } }) as Awaited<ReturnType<typeof client.chain>>;
  client.backend.assertApiKeyGrant = async () => {
    checks += 1;
    return { id: "key_1", name: "MCP", scopes: ["mcp:read", "mcp:write"], grants: [],
      expiresAt: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
  };
  try {
    await client.assertAccount(10143);
    await client.assertAccount(10143);
    assert.equal(checks, 2);
  } finally {
    await client.close();
  }
});
