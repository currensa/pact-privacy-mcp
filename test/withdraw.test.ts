import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildPoseidon } from "circomlibjs";
import type { PactPrivacyBackend } from "../src/backend/client.js";
import type { LocalProofService } from "../src/proof/prover.js";
import { WithdrawPayloadStore } from "../src/withdraw/payload-store.js";
import { WithdrawProofService } from "../src/withdraw/proof.js";
import { directWithdrawParties } from "../src/withdraw/prepare.js";

test("keeps the direct withdrawal fee with the signer while allowing another recipient", () => {
  const signer = "0xdd7c3b6da39458acfc9893a94e467161c993b9b7";
  const recipient = "0xdbC13E144ecd4f156fB988B4a8dFF79597002BF5";
  const parties = directWithdrawParties(signer, recipient, "evm");
  assert.equal(parties.relayer, signer);
  assert.equal(parties.recipient, "0xdbc13e144ecd4f156fb988b4a8dff79597002bf5");
  assert.deepEqual(directWithdrawParties(signer, undefined, "evm"), { recipient: signer, relayer: signer });
});

test("builds a withdrawal proof locally from a verified fresh membership path", async () => {
  const poseidon = await buildPoseidon() as ((values: bigint[]) => unknown) & { F: { toObject(value: unknown): bigint } };
  const hash2 = (left: bigint, right: bigint) => poseidon.F.toObject(poseidon([left, right]));
  const depositLeaf = hash2(0n, 0n);
  const siblings = new Array<string>(20).fill("0");
  let root = depositLeaf;
  for (let level = 0; level < 20; level += 1) root = hash2(root, 0n);
  let proofInput: Record<string, unknown> | undefined;
  const backend = {
    async depositMembership() {
      return { root: root.toString(), depositLeaf: depositLeaf.toString(), siblings, pathIndices: new Array(20).fill(0), leafCount: 1 };
    },
  } as unknown as PactPrivacyBackend;
  const proofs = {
    async prove(circuit: string, tier: number, input: Record<string, unknown>) {
      assert.equal(circuit, "withdraw");
      assert.equal(tier, 8);
      proofInput = input;
      return {
        pA: ["1", "2"], pB: [["3", "4"], ["5", "6"]], pC: ["7", "8"],
        publicSignals: [], bundleVersion: "11".repeat(32),
      };
    },
  } as unknown as LocalProofService;
  const result = await new WithdrawProofService(backend, proofs).generate({
    chainId: 11142220,
    info: {
      nullifier: "123",
      amount: "1000",
      token: "0x0000000000000000000000000000000000000000",
      leafIndex: 0,
      tier: 8,
      authRoot: "0",
      depositorSecretHash: "0",
      authPathElements: ["0", "0", "0"],
      authPathIndices: [0, 0, 0],
    },
    rawSecret: "local secret",
    recipient: "0x0000000000000000000000000000000000000001",
    relayer: "0x0000000000000000000000000000000000000001",
    claimedAmount: 100n,
    nonce: 2n,
    expectedAmount: 500n,
    fee: 1n,
  });
  assert.equal(result.depositRoot, root);
  assert.equal(proofInput?.claimedAmount, "100");
  assert.equal(proofInput?.expectedAmount, "500");
  assert.equal((proofInput?.depositPathElements as string[]).length, 20);
  assert.equal(typeof proofInput?.secret, "string");
});

test("withdrawal recovery payload persists only the signed transaction", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "pact-withdraw-payload-"));
  const store = new WithdrawPayloadStore(directory);
  const operationId = "op_abc_0011223344556677";
  await store.saveTransaction(operationId, {
    purpose: "withdraw",
    family: "evm",
    hash: `0x${"ab".repeat(32)}`,
    raw: "0xsigned-withdrawal",
  });
  const path = resolve(directory, `${operationId}.withdraw.json`);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /nullifier|rawSecret|authPath|password|proof|witness/);
  assert.equal((await store.get(operationId)).transaction?.purpose, "withdraw");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
});
