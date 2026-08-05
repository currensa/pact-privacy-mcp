import { randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import type { PactPrivacyBackend } from "../backend/client.js";
import type { CircuitTier } from "../proof/artifact-cache.js";
import type { LocalProofService } from "../proof/prover.js";
import type { DepositProofResult, DepositReceiver } from "./types.js";

const TREE_DEPTH = 20;
const FAKE_DEPOSITOR_SECRET_HASH = 1111111111111111111111111111111111111111111111111111111111111111n;
const TIER_AUTH_DEPTH: Record<CircuitTier, number> = { 8: 3, 16: 4, 32: 5, 64: 6, 128: 7 };

type Poseidon = ((values: bigint[]) => unknown) & { F: { toObject(value: unknown): bigint } };

export function selectDepositTier(count: number): CircuitTier {
  for (const tier of [8, 16, 32, 64, 128] as const) if (count <= tier) return tier;
  throw new Error("Too many receivers; the maximum is 128");
}

function randomField(): bigint {
  return BigInt(`0x${randomBytes(31).toString("hex")}`);
}

function hex32(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export class DepositProofService {
  constructor(private readonly backend: PactPrivacyBackend, private readonly proofs: LocalProofService) {}

  async generate(input: {
    receivers: DepositReceiver[];
    token: bigint;
    chainId: number;
    refund: boolean;
    depositorSecretHash?: string;
  }): Promise<DepositProofResult> {
    if (input.receivers.length === 0) throw new Error("At least one receiver is required");
    const tier = selectDepositTier(input.receivers.length);
    const poseidon = await buildPoseidon() as Poseidon;
    const field = poseidon.F;
    const hash = (values: bigint[]): bigint => field.toObject(poseidon(values)) as bigint;
    const hash2 = (left: bigint, right: bigint): bigint => hash([left, right]);
    const canRefund: 0 | 1 = input.refund ? 1 : 0;
    if (input.refund && !input.depositorSecretHash) throw new Error("Depositor account data is required for refund support");
    const depositorSecretHash = input.refund ? BigInt(input.depositorSecretHash!) : FAKE_DEPOSITOR_SECRET_HASH;

    const nullifiers = input.receivers.map((receiver) => (
      hash([BigInt(receiver.encPubkey.startsWith("0x") ? receiver.encPubkey : `0x${receiver.encPubkey}`), randomField()])
    ));
    const amounts = input.receivers.map((receiver) => receiver.amount);
    const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
    const commitments = input.receivers.map((receiver, index) => hash([BigInt(receiver.secretHash), nullifiers[index]!]));
    const leaves = commitments.map((commitment, index) => hash([amounts[index]!, input.token, commitment]));

    const amountsPadded = [...amounts];
    const commitmentsPadded = [...commitments];
    const nullifiersPadded = [...nullifiers];
    const secretHashesPadded = input.receivers.map((receiver) => BigInt(receiver.secretHash));
    while (leaves.length < tier) {
      let commitment = 0n;
      let nullifier = 0n;
      let secretHash = 0n;
      if (input.refund) {
        nullifier = randomField();
        secretHash = hash([randomField()]);
        commitment = hash([secretHash, nullifier]);
      }
      leaves.push(hash([0n, input.token, commitment]));
      amountsPadded.push(0n);
      commitmentsPadded.push(commitment);
      nullifiersPadded.push(nullifier);
      secretHashesPadded.push(secretHash);
    }

    const size = 1 << TIER_AUTH_DEPTH[tier];
    const tree = new Array<bigint>(2 * size).fill(0n);
    leaves.forEach((leaf, index) => { tree[size + index] = leaf; });
    for (let index = size - 1; index >= 1; index -= 1) tree[index] = hash2(tree[index * 2]!, tree[index * 2 + 1]!);
    const authRoot = tree[1]!;
    const authPaths = input.receivers.map((_, receiverIndex) => {
      const pathElements: bigint[] = [];
      const pathIndices: number[] = [];
      let index = size + receiverIndex;
      while (index > 1) {
        const right = index & 1;
        pathElements.push(tree[right ? index - 1 : index + 1]!);
        pathIndices.push(right);
        index >>= 1;
      }
      return { pathElements, pathIndices };
    });

    const path = await this.backend.depositPath(input.chainId);
    if (!Number.isSafeInteger(path.nextIndex) || path.nextIndex < 0 || path.siblings.length !== TREE_DEPTH) {
      throw new Error("Backend returned an invalid deposit insertion path");
    }
    const siblings = path.siblings.map(BigInt);
    const zeros: bigint[] = [0n];
    for (let level = 0; level < TREE_DEPTH; level += 1) zeros.push(hash2(zeros[level]!, zeros[level]!));

    let oldRoot = 0n;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const bit = (path.nextIndex >> level) & 1;
      const sibling = bit === 1 ? siblings[level]! : zeros[level]!;
      oldRoot = bit === 0 ? hash2(oldRoot, sibling) : hash2(sibling, oldRoot);
    }
    const depositLeaf = hash2(authRoot, depositorSecretHash);
    let newRoot = depositLeaf;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const bit = (path.nextIndex >> level) & 1;
      newRoot = bit === 1 ? hash2(siblings[level]!, newRoot) : hash2(newRoot, zeros[level]!);
    }

    const proof = await this.proofs.prove("deposit", tier, {
      newDepositRoot: newRoot.toString(),
      oldRoot: oldRoot.toString(),
      depositLeaf: depositLeaf.toString(),
      leafIndex: path.nextIndex.toString(),
      totalAmount: totalAmount.toString(),
      token: input.token.toString(),
      oldFilledSubtrees: siblings.map(String),
      commitments: commitmentsPadded.map(String),
      amounts: amountsPadded.map(String),
      depositorSecretHash: depositorSecretHash.toString(),
      canRefund: canRefund.toString(),
    });

    return {
      proof: { pA: proof.pA, pB: proof.pB, pC: proof.pC },
      tier,
      newDepositRoot: hex32(newRoot),
      oldDepositRoot: hex32(oldRoot),
      authRoot: hex32(authRoot),
      depositLeaf: hex32(depositLeaf),
      depositorSecretHash: hex32(depositorSecretHash),
      canRefund,
      totalAmount,
      leafIndex: path.nextIndex,
      receivers: input.receivers.map((receiver, index) => ({
        address: receiver.address,
        nullifier: hex32(nullifiers[index]!),
        amount: receiver.amount.toString(),
        encPubkey: receiver.encPubkey,
        authPathElements: authPaths[index]!.pathElements.map(hex32),
        authPathIndices: authPaths[index]!.pathIndices,
      })),
      refundEntries: nullifiersPadded.map((nullifier, index) => ({
        nullifier: hex32(nullifier),
        secretHash: hex32(secretHashesPadded[index]!),
        amount: amountsPadded[index]!.toString(),
      })),
    };
  }
}
