import { buildPoseidon } from "circomlibjs";
import type { PactPrivacyBackend } from "../backend/client.js";
import type { CanonicalAddress } from "../core/types.js";
import type { LocalProofService } from "../proof/prover.js";
import { secretStringToField } from "../proof/poseidon.js";
import type { RefundContent, RefundProofResult } from "./types.js";

const TREE_DEPTH = 20;
const AUTH_DEPTH = { 8: 3, 16: 4, 32: 5, 64: 6, 128: 7 } as const;
type Poseidon = ((values: bigint[]) => unknown) & { F: { toObject(value: unknown): bigint } };

function hex32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export class RefundProofService {
  constructor(private readonly backend: PactPrivacyBackend, private readonly proofs: LocalProofService) {}

  async generate(input: {
    chainId: number;
    leafIndex: number;
    content: RefundContent;
    rawSecret: string;
    totalClaimed: bigint;
    refundAmount: bigint;
    fee: bigint;
    relayer: CanonicalAddress;
    refunder: CanonicalAddress;
  }): Promise<RefundProofResult> {
    const authDepth = AUTH_DEPTH[input.content.tier];
    if (!authDepth || input.content.refundEntries.length !== input.content.tier) {
      throw new Error(`Unsupported or invalid refund tier: ${input.content.tier}`);
    }
    const poseidon = await buildPoseidon() as Poseidon;
    const hash2 = (left: bigint, right: bigint): bigint => poseidon.F.toObject(poseidon([left, right]));
    const hash3 = (first: bigint, second: bigint, third: bigint): bigint => (
      poseidon.F.toObject(poseidon([first, second, third]))
    );
    const token = BigInt(input.content.token);
    const nullifiers = input.content.refundEntries.map((entry) => BigInt(entry.nullifier));
    const secretHashes = input.content.refundEntries.map((entry) => BigInt(entry.secretHash));
    const amounts = input.content.refundEntries.map((entry) => BigInt(entry.amount));
    const nullifierHashes = nullifiers.map((nullifier) => poseidon.F.toObject(poseidon([nullifier])));

    let authLevel = input.content.refundEntries.map((entry, index) => hash3(
      BigInt(entry.amount), token, hash2(secretHashes[index]!, nullifiers[index]!),
    ));
    for (let depth = 0; depth < authDepth; depth += 1) {
      const next: bigint[] = [];
      for (let index = 0; index < authLevel.length; index += 2) {
        next.push(hash2(authLevel[index]!, authLevel[index + 1]!));
      }
      authLevel = next;
    }
    const authRoot = authLevel[0]!;
    if (authRoot !== BigInt(input.content.authRoot)) throw new Error("Refund content authorization root mismatch");

    const depositSecret = await secretStringToField(input.rawSecret);
    const depositorSecretHash = poseidon.F.toObject(poseidon([depositSecret]));
    if (depositorSecretHash !== BigInt(input.content.depositorSecretHash)) {
      throw new Error("Depositor secret does not match this deposit");
    }
    const depositLeaf = hash2(authRoot, depositorSecretHash);
    if (depositLeaf !== BigInt(input.content.depositLeaf)) throw new Error("Refund content deposit leaf mismatch");

    const membership = await this.backend.depositMembership(input.chainId, input.leafIndex);
    if (
      membership.siblings.length !== TREE_DEPTH
      || membership.pathIndices.length !== TREE_DEPTH
      || membership.pathIndices.some((bit, level) => bit !== 0 && bit !== 1 || bit !== ((input.leafIndex >> level) & 1))
      || !Number.isSafeInteger(membership.leafCount)
      || membership.leafCount <= input.leafIndex
      || depositLeaf !== BigInt(membership.depositLeaf)
    ) throw new Error("Backend returned an invalid deposit membership path");
    let depositRoot = depositLeaf;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const sibling = BigInt(membership.siblings[level]!);
      depositRoot = membership.pathIndices[level] === 0 ? hash2(depositRoot, sibling) : hash2(sibling, depositRoot);
    }
    if (depositRoot !== BigInt(membership.root)) throw new Error("Backend returned an inconsistent deposit root");

    const totalAllocated = amounts.reduce((sum, amount) => sum + amount, 0n);
    if (input.totalClaimed > totalAllocated || input.refundAmount !== totalAllocated - input.totalClaimed) {
      throw new Error("Refund totals do not match the encrypted allocations");
    }
    if (input.refundAmount <= 0n) throw new Error("Nothing remains to refund");
    if (input.fee * 1000n < input.refundAmount) throw new Error("Refund fee is below the contract minimum");

    const proof = await this.proofs.prove("refund", input.content.tier, {
      depositRoot: depositRoot.toString(),
      nullifierHash: nullifierHashes.map(String),
      totalClaimed: input.totalClaimed.toString(),
      token: token.toString(),
      refundAmount: input.refundAmount.toString(),
      fee: input.fee.toString(),
      relayer: BigInt(input.relayer).toString(),
      refunder: BigInt(input.refunder).toString(),
      depositSecret: depositSecret.toString(),
      nullifier: nullifiers.map(String),
      secretHash: secretHashes.map(String),
      withdrawAmount: amounts.map(String),
      depositPathElements: membership.siblings.map((value) => BigInt(value).toString()),
      depositPathIndices: membership.pathIndices.map(String),
    });
    return {
      proof: { pA: proof.pA, pB: proof.pB, pC: proof.pC },
      depositRoot,
      nullifierHashes: nullifierHashes.map(hex32),
      refundAmount: input.refundAmount,
      fee: input.fee,
      token: input.content.token,
      tier: input.content.tier,
      relayer: input.relayer,
      refunder: input.refunder,
    };
  }
}
