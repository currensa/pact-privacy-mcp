import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountStore, profileFromEnvironment } from "../src/accounts/store.js";
import { OnboardingService } from "../src/cli/onboarding.js";
import type { Prompter } from "../src/cli/prompts.js";
import { LocalSigner } from "../src/wallet/local-signer.js";

const signer = new LocalSigner(`0x${"11".repeat(32)}`);

function prompter(): Prompter {
  return {
    confirm: async () => true,
    text: async (label) => label === "Organization member name" ? "Alice"
      : label === "API key name" ? "MCP" : "365",
    secret: async (label) => ({
      "Organization invite code": "invite_1",
      "Private key": signer.privateKey,
      "Account password": "password",
      "Confirm account password": "password",
      "Existing Organization API key (leave blank to create one)": "",
      "EVM account secret (leave blank to generate securely)": "",
    })[label] ?? "",
  };
}

test("Organization account add joins by invite and persists only a local protected profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "org-onboarding-"));
  const store = new AccountStore(directory);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  let authenticatedMeCalls = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ path, body });
    if (path.endsWith("wallet/challenge")) return Response.json({
      nonce: `0x${"22".repeat(32)}`, expiresAt: Date.now() + 60_000,
      action: body?.action, payloadHash: body?.payloadHash, family: "evm",
      domain: { name: "PactPay", version: "1" },
    });
    if (path.endsWith("auth/login")) return Response.json({ userId: "user_1", token: "session" });
    if (path.endsWith("auth/me")) {
      if (new Headers(init?.headers).has("authorization")) {
        authenticatedMeCalls += 1;
        if (authenticatedMeCalls === 2) throw new TypeError("fetch failed");
      }
      return Response.json({ user: { userId: "user_1" },
        accounts: [{ type: "wallet", account: signer.displayAddress("evm") }] });
    }
    if (path.includes("invite-code/invite_1/membership")) return Response.json({ isMember: false, orgId: "org_1" });
    if (path.endsWith("orgs/join")) return Response.json({
      member: { orgId: "org_1", memberId: "member_1", status: "active", showName: "Alice" }, message: "joined",
    });
    if (path.endsWith("gravarc-user-info/detail")) return new Response(null, { status: 200 });
    if (path.endsWith("auth/gravarc-user-info")) return Response.json({ success: true });
    if (path.endsWith("api-keys/self")) return Response.json({ id: "key_1", userId: "user_1",
      name: "MCP", scopes: ["mcp:read", "mcp:write"], expiresAt: null, lastUsedAt: null,
      createdAt: new Date().toISOString() });
    if (path.endsWith("api-keys")) return Response.json({ id: "key_1", plainKey: "pk_live_test",
      name: "MCP", scopes: ["mcp:read", "mcp:write"], expiresAt: null, createdAt: new Date().toISOString() });
    throw new Error(`Unexpected path: ${path}`);
  };
  try {
    const result = await new OnboardingService(prompter(), store).provision({ backendUrl: "http://localhost:3000/api" });
    assert.equal(result.environment.apiKey, "pk_live_test");
    assert.equal(authenticatedMeCalls, 3);
    assert.deepEqual(result.families, ["evm"]);
    assert.deepEqual(calls.find((call) => call.path.endsWith("orgs/join"))?.body,
      { code: "invite_1", showName: "Alice" });
    const registration = calls.find((call) => call.path.endsWith("auth/gravarc-user-info") && call.body);
    assert.equal(registration?.body?.address, signer.address("evm"));
    const profile = await store.get(signer.address("evm"));
    assert.equal(profile.apiKey, "pk_live_test");
    assert.equal((await stat(join(directory, "accounts", `${signer.address("evm")}.json`))).mode & 0o077, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Organization account add rejects an empty member name before remote authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "org-onboarding-name-"));
  const store = new AccountStore(directory);
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("Unexpected request");
  };
  const emptyNamePrompter: Prompter = {
    ...prompter(),
    text: async (label) => label === "Organization member name" ? "   " : "365",
  };
  try {
    await assert.rejects(
      () => new OnboardingService(emptyNamePrompter, store).provision({ backendUrl: "http://localhost:3000/api" }),
      /Organization member name is required/,
    );
    assert.equal(fetched, false);
    assert.deepEqual(await store.list(), []);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Rejected invitation preserves the wallet locally but does not create an API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "org-onboarding-rejected-"));
  const store = new AccountStore(directory);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith("wallet/challenge")) return Response.json({
      nonce: `0x${"22".repeat(32)}`, expiresAt: Date.now() + 60_000, action: "login",
      payloadHash: `0x${"00".repeat(32)}`, family: "evm", domain: { name: "PactPay", version: "1" },
    });
    if (path.endsWith("auth/login")) return Response.json({ userId: "user_1", token: "session" });
    if (path.endsWith("auth/me")) return Response.json({ user: { userId: "user_1" },
      accounts: [{ type: "wallet", account: signer.displayAddress("evm") }] });
    if (path.includes("invite-code/invite_1/membership")) return Response.json({ isMember: false, orgId: "org_1" });
    if (path.endsWith("orgs/join")) return Response.json({ message: "Invalid invite" }, { status: 400 });
    throw new Error(`Unexpected route: ${path} (${init?.method})`);
  };
  try {
    await assert.rejects(() => new OnboardingService(prompter(), store).provision({ backendUrl: "http://localhost:3000/api" }),
      /Invalid invite/);
    const profile = await store.get(signer.address("evm"));
    assert.equal(profile.privateKey, signer.privateKey);
    assert.equal(profile.apiKey, undefined);
    assert.equal(calls.some((path) => path.endsWith("api-keys")), false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Approved incomplete account resumes its wallet and finishes API-key setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "org-onboarding-resume-"));
  const store = new AccountStore(directory);
  await store.add(profileFromEnvironment({ privateKey: signer.privateKey, password: "password" }, ["evm"]));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path.endsWith("wallet/challenge")) return Response.json({
      nonce: `0x${"22".repeat(32)}`, expiresAt: Date.now() + 60_000,
      action: body?.action, payloadHash: body?.payloadHash, family: "evm",
      domain: { name: "PactPay", version: "1" },
    });
    if (path.endsWith("auth/login")) return Response.json({ userId: "user_1", token: "session" });
    if (path.endsWith("auth/me")) return Response.json({ user: { userId: "user_1" },
      accounts: [{ type: "wallet", account: signer.displayAddress("evm") }] });
    if (path.includes("invite-code/invite_1/membership")) return Response.json({ isMember: true, orgId: "org_1" });
    if (path.endsWith("orgs")) return Response.json([{ organization: { orgId: "org_1", orgName: "Org" },
      member: { memberId: "member_1", status: "active", showName: null, roles: [{ role: "Member" }] } }]);
    if (path.endsWith("orgs/org_1/members/member_1/profile")) return Response.json({
      memberId: "member_1", status: "active", showName: "Alice",
    });
    if (path.endsWith("gravarc-user-info/detail")) return Response.json({ address: signer.address("evm"),
      encryptedSecret: null, secretHash: `0x${"33".repeat(32)}`, encPubkey: null });
    if (path.endsWith("api-keys/self")) return Response.json({ id: "key_1", userId: "user_1",
      name: "MCP", scopes: ["mcp:read", "mcp:write"], expiresAt: null, lastUsedAt: null,
      createdAt: new Date().toISOString() });
    if (path.endsWith("api-keys")) return Response.json({ id: "key_1", plainKey: "pk_live_test",
      name: "MCP", scopes: ["mcp:read", "mcp:write"], expiresAt: null, createdAt: new Date().toISOString() });
    throw new Error(`Unexpected path: ${path}`);
  };
  try {
    const result = await new OnboardingService(prompter(), store).provision({ backendUrl: "http://localhost:3000/api" });
    assert.equal(result.environment.apiKey, "pk_live_test");
    assert.equal(calls.some((call) => call.path.endsWith("orgs/join")), false);
    assert.deepEqual(calls.find((call) => call.path.endsWith("members/member_1/profile"))?.body,
      { showName: "Alice" });
    assert.equal((await store.get(signer.address("evm"))).apiKey, "pk_live_test");
    assert.equal((await store.shared()).backendUrl, "http://localhost:3000/api");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Account add does not send a saved key to a different backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "org-onboarding-backend-"));
  const store = new AccountStore(directory);
  await store.add(profileFromEnvironment({ privateKey: signer.privateKey, password: "password",
    apiKey: "pk_live_old", backendUrl: "https://old.example/api" }, ["evm"]));
  await store.updateShared({ backendUrl: "https://old.example/api" });
  const originalFetch = globalThis.fetch;
  const headers: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    headers.push(new Headers(init?.headers));
    return Response.json({ message: "Invalid invite" }, { status: 400 });
  };
  try {
    await assert.rejects(() => new OnboardingService(prompter(), store).provision({ backendUrl: "https://new.example/api" }), /Invalid invite/);
    assert.equal(headers[0]?.has("x-api-key"), false);
    assert.equal((await store.shared()).backendUrl, "https://old.example/api");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
