import { buildPoseidon } from "circomlibjs";
import type { CanonicalAddress } from "../core/types.js";
import type { PactPrivacyBackend } from "../backend/client.js";
import type { LocalProofService } from "../proof/prover.js";
import { secretStringToField } from "../proof/poseidon.js";
import type { WithdrawMessage } from "../discovery/service.js";
import type { CircuitTier } from "../proof/artifact-cache.js";
import type { WithdrawProofResult } from "./types.js";

const TREE_DEPTH = 20;
const AUTH_DEPTH: Record<CircuitTier, number> = { 8: 3, 16: 4, 32: 5, 64: 6, 128: 7 };
type Poseidon = ((values: bigint[]) => unknown) & { F: { toObject(value: unknown): bigint } };

function hex32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export class WithdrawProofService {
  constructor(private readonly backend: PactPrivacyBackend, private readonly proofs: LocalProofService) {}

  async generate(input: {
    chainId: number;
    info: WithdrawMessage;
    rawSecret: string;
    recipient: CanonicalAddress;
    relayer: CanonicalAddress;
    claimedAmount: bigint;
    nonce: bigint;
    expectedAmount: bigint;
    fee: bigint;
  }): Promise<WithdrawProofResult> {
    const tier = input.info.tier as CircuitTier;
    const authDepth = AUTH_DEPTH[tier];
    if (!authDepth) throw new Error(`Unsupported withdrawal tier: ${input.info.tier}`);
    if (input.info.authPathElements.length !== authDepth || input.info.authPathIndices.length !== authDepth) {
      throw new Error("Encrypted allocation has an invalid authorization path");
    }
    const poseidon = await buildPoseidon() as Poseidon;
    const hash2 = (left: bigint, right: bigint): bigint => poseidon.F.toObject(poseidon([left, right]));
    const nullifier = BigInt(input.info.nullifier);
    const nullifierHash = poseidon.F.toObject(poseidon([nullifier]));
    const depositLeaf = hash2(BigInt(input.info.authRoot), BigInt(input.info.depositorSecretHash));
    const membership = await this.backend.depositMembership(input.chainId, input.info.leafIndex);
    if (
      membership.siblings.length !== TREE_DEPTH
      || membership.pathIndices.length !== TREE_DEPTH
      || membership.pathIndices.some((bit, level) => bit !== 0 && bit !== 1 || bit !== ((input.info.leafIndex >> level) & 1))
      || !Number.isSafeInteger(membership.leafCount)
      || membership.leafCount <= input.info.leafIndex
      || depositLeaf !== BigInt(membership.depositLeaf)
    ) throw new Error("Backend returned an invalid deposit membership path");
    let depositRoot = depositLeaf;
    for (let level = 0; level < TREE_DEPTH; level += 1) {
      const sibling = BigInt(membership.siblings[level]!);
      depositRoot = membership.pathIndices[level] === 0 ? hash2(depositRoot, sibling) : hash2(sibling, depositRoot);
    }
    if (depositRoot !== BigInt(membership.root)) throw new Error("Backend returned an inconsistent deposit root");
    const total = BigInt(input.info.amount);
    if (input.expectedAmount <= 0n || input.claimedAmount + input.expectedAmount > total) {
      throw new Error("Withdrawal amount exceeds the current remaining allocation");
    }
    const proof = await this.proofs.prove("withdraw", tier, {
      depositRoot: depositRoot.toString(),
      nullifierHash: nullifierHash.toString(),
      receiver: BigInt(input.recipient).toString(),
      claimedAmount: input.claimedAmount.toString(),
      token: BigInt(input.info.token).toString(),
      expectedAmount: input.expectedAmount.toString(),
      fee: input.fee.toString(),
      relayer: BigInt(input.relayer).toString(),
      nonce: input.nonce.toString(),
      authRoot: BigInt(input.info.authRoot).toString(),
      nullifier: nullifier.toString(),
      secret: (await secretStringToField(input.rawSecret)).toString(),
      withdrawAmount: total.toString(),
      depositorSecretHash: BigInt(input.info.depositorSecretHash).toString(),
      authPathElements: input.info.authPathElements.map((value) => BigInt(value).toString()),
      authPathIndices: input.info.authPathIndices.map(String),
      depositPathElements: membership.siblings.map((value) => BigInt(value).toString()),
      depositPathIndices: membership.pathIndices.map(String),
    });
    return {
      proof: { pA: proof.pA, pB: proof.pB, pC: proof.pC },
      nullifierHash: hex32(nullifierHash),
      depositRoot,
      claimedAmount: input.claimedAmount,
      expectedAmount: input.expectedAmount,
      fee: input.fee,
      relayer: input.relayer,
      recipient: input.recipient,
      nonce: input.nonce,
      token: input.info.token as CanonicalAddress,
      tier,
    };
  }
}
