import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildPoseidon } from "circomlibjs";
import type { PactPrivacyBackend } from "../src/backend/client.js";
import type { LocalProofService } from "../src/proof/prover.js";
import { secretStringToField } from "../src/proof/poseidon.js";
import { RefundPayloadStore } from "../src/refund/payload-store.js";
import { RefundProofService } from "../src/refund/proof.js";

test("builds a refund proof locally from encrypted entries and a fresh membership path", async () => {
  const poseidon = await buildPoseidon() as ((values: bigint[]) => unknown) & { F: { toObject(value: unknown): bigint } };
  const hash = (values: bigint[]) => poseidon.F.toObject(poseidon(values));
  const rawSecret = "local depositor secret";
  const depositSecret = await secretStringToField(rawSecret);
  const depositorSecretHash = hash([depositSecret]);
  const entries = new Array(8).fill(undefined).map((_, index) => ({
    nullifier: String(index + 1),
    secretHash: String(index + 101),
    amount: index === 0 ? "1000" : "0",
  }));
  let authLevel = entries.map((entry) => hash([
    BigInt(entry.amount),
    0n,
    hash([BigInt(entry.secretHash), BigInt(entry.nullifier)]),
  ]));
  for (let depth = 0; depth < 3; depth += 1) {
    const next: bigint[] = [];
    for (let index = 0; index < authLevel.length; index += 2) next.push(hash([authLevel[index]!, authLevel[index + 1]!]));
    authLevel = next;
  }
  const authRoot = authLevel[0]!;
  const depositLeaf = hash([authRoot, depositorSecretHash]);
  const siblings = new Array<string>(20).fill("0");
  let root = depositLeaf;
  for (let level = 0; level < 20; level += 1) root = hash([root, 0n]);
  const backend = {
    async depositMembership() {
      return { root: root.toString(), depositLeaf: depositLeaf.toString(), siblings, pathIndices: new Array(20).fill(0), leafCount: 1 };
    },
  } as unknown as PactPrivacyBackend;
  let proofInput: Record<string, unknown> | undefined;
  const proofs = {
    async prove(circuit: string, tier: number, input: Record<string, unknown>) {
      assert.equal(circuit, "refund");
      assert.equal(tier, 8);
      proofInput = input;
      return {
        pA: ["1", "2"], pB: [["3", "4"], ["5", "6"]], pC: ["7", "8"],
        publicSignals: [], bundleVersion: "11".repeat(32),
      };
    },
  } as unknown as LocalProofService;
  const result = await new RefundProofService(backend, proofs).generate({
    chainId: 11142220,
    leafIndex: 0,
    content: {
      token: "0x0000000000000000000000000000000000000000",
      tier: 8,
      authRoot: authRoot.toString(),
      depositLeaf: depositLeaf.toString(),
      depositorSecretHash: depositorSecretHash.toString(),
      refundEntries: entries,
    },
    rawSecret,
    totalClaimed: 100n,
    refundAmount: 900n,
    fee: 1n,
    relayer: "0x0000000000000000000000000000000000000001",
    refunder: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(result.depositRoot, root);
  assert.equal(result.refundAmount, 900n);
  assert.equal(result.nullifierHashes.length, 8);
  assert.equal(proofInput?.totalClaimed, "100");
  assert.equal((proofInput?.depositPathElements as string[]).length, 20);
  assert.equal((proofInput?.nullifier as string[]).length, 8);
  assert.equal(typeof proofInput?.depositSecret, "string");
});

test("refund recovery payload persists only the signed transaction", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-refund-payload-"));
  const store = new RefundPayloadStore(directory);
  const operationId = "op_abc_0011223344556677";
  await store.saveTransaction(operationId, {
    purpose: "refund",
    family: "evm",
    hash: `0x${"ab".repeat(32)}`,
    raw: "0xsigned-refund",
  });
  const path = resolve(directory, `${operationId}.refund.json`);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /nullifier|rawSecret|depositSecret|password|proof|witness/);
  assert.equal((await store.get(operationId)).transaction?.purpose, "refund");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
});
