import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { canonicalFromTronAddress, tronBase58FromCanonical } from "../src/chain/address.js";
import { closeChainRuntime, createChainRuntime } from "../src/chain/runtime.js";
import { loadEnvironment, writeEnvironment } from "../src/config/env.js";
import { buildAccountRegistration, decryptOwnSecret, deriveEncryptionKeyPair } from "../src/crypto/account.js";
import { LocalSigner } from "../src/wallet/local-signer.js";
import { verifyTypedData } from "ethers";
import { Trx } from "tronweb";
import { tronAuthorizationMessage, type AuthorizationChallenge } from "../src/wallet/local-signer.js";

const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

test("one private key derives the same canonical EVM and TRON account", () => {
  const signer = new LocalSigner(PRIVATE_KEY);
  assert.equal(signer.address("evm"), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  assert.equal(signer.address("tron"), signer.address("evm"));
  assert.equal(canonicalFromTronAddress(signer.displayAddress("tron")), signer.address("tron"));
  assert.equal(tronBase58FromCanonical(signer.address("tron")), signer.displayAddress("tron"));
});

test("closing an EVM runtime destroys its JSON-RPC provider", () => {
  const signer = new LocalSigner(PRIVATE_KEY);
  const runtime = createChainRuntime({
    chainId: 1,
    family: "evm",
    chainName: "Test",
    rpcUrls: ["http://127.0.0.1:1"],
    gravArc: "0x0000000000000000000000000000000000000001",
    erc20Tokens: [],
    defiProtocols: [],
  }, signer);
  assert.equal(runtime.family, "evm");
  if (runtime.family !== "evm") throw new Error("Expected EVM runtime");
  assert.equal(runtime.provider.destroyed, false);
  closeChainRuntime(runtime);
  assert.equal(runtime.provider.destroyed, true);
});

test("account encryption is deterministic by family and decrypts locally", async () => {
  const signer = new LocalSigner(PRIVATE_KEY);
  const evm = await deriveEncryptionKeyPair("password", signer, "evm");
  const evmAgain = await deriveEncryptionKeyPair("password", signer, "evm");
  const tron = await deriveEncryptionKeyPair("password", signer, "tron");
  assert.deepEqual(evm.publicKey, evmAgain.publicKey);
  assert.notDeepEqual(evm.publicKey, tron.publicKey);

  const registration = await buildAccountRegistration(signer, "evm", "password", "private secret");
  assert.match(registration.secretHash, /^0x[0-9a-f]{64}$/);
  assert.match(registration.encPubkey, /^[0-9a-f]{64}$/);
  assert.equal(decryptOwnSecret(registration.encryptedSecret, evm.secretKey), "private secret");
});

test("local authorization signatures recover for both backend families", async () => {
  const signer = new LocalSigner(PRIVATE_KEY);
  const base = {
    nonce: `0x${"11".repeat(32)}`,
    expiresAt: 2_000_000_000_000,
    action: "login",
    payloadHash: `0x${"00".repeat(32)}`,
    domain: { name: "Pact Privacy", version: "2" },
  };
  const evm = { ...base, family: "evm" } satisfies AuthorizationChallenge;
  const evmSignature = await signer.signChallenge(evm);
  const recovered = verifyTypedData(evm.domain, {
    WalletAuthorization: [
      { name: "action", type: "string" },
      { name: "family", type: "string" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint256" },
      { name: "payloadHash", type: "bytes32" },
    ],
  }, {
    action: evm.action,
    family: evm.family,
    nonce: evm.nonce,
    expiresAt: BigInt(evm.expiresAt),
    payloadHash: evm.payloadHash,
  }, evmSignature);
  assert.equal(recovered.toLowerCase(), signer.address("evm"));

  const tron = { ...base, family: "tron" } satisfies AuthorizationChallenge;
  const tronSignature = await signer.signChallenge(tron);
  assert.equal(
    canonicalFromTronAddress(Trx.verifyMessageV2(tronAuthorizationMessage(tron), tronSignature)),
    signer.address("tron"),
  );
});

test("environment writes are private, atomic, and preserve unmanaged values", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-privacy-mcp-"));
  const path = resolve(directory, ".env");
  await writeFile(path, "CUSTOM_VALUE=keep\nPRIVATE_KEY=old\n", { mode: 0o600 });
  await writeEnvironment(path, {
    privateKey: PRIVATE_KEY,
    backendUrl: "http://localhost:5001/",
    password: "local password",
    apiKey: "private api key",
  }, { replace: true });

  const contents = await readFile(path, "utf8");
  assert.match(contents, /^CUSTOM_VALUE=keep/m);
  assert.doesNotMatch(contents, /PRIVATE_KEY=old/);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
  assert.deepEqual(await loadEnvironment(path), {
    privateKey: PRIVATE_KEY,
    backendUrl: "http://localhost:5001",
    password: "local password",
    apiKey: "private api key",
  });
});
