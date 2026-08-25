import { getPoseidon, secretStringToField, toHex64 } from './poseidon.js';
import { groth16Prove, type CircuitFiles, type Groth16ProofPoints } from './prover.js';

const TREE_DEPTH = 20;
const TIER_AUTH_DEPTH: Record<number, number> = { 8: 3, 16: 4, 32: 5, 64: 6, 128: 7 };

function buildAuthTree(leaves: bigint[], depth: number, hash2: (a: bigint, b: bigint) => bigint) {
    const size = 1 << depth;
    const tree = new Array<bigint>(2 * size).fill(0n);
    for (let i = 0; i < leaves.length; i += 1) tree[size + i] = leaves[i];
    for (let i = size - 1; i >= 1; i -= 1) tree[i] = hash2(tree[2 * i], tree[2 * i + 1]);
    return { root: tree[1] };
}

export type RefundSlot = {
    nullifier: string;
    secretHash: string;
    withdrawAmount: string;
};

export type RefundProofInput = {
    slots: RefundSlot[];
    depositSecret: string;
    token: string;
    tier: number;
    depositPathElements: string[];
    depositPathIndices: number[];
    totalClaimed: bigint;
    fee: bigint;
    relayer: string;
    refunder: string;
    circuit: CircuitFiles;
};

export type RefundProofResult = {
    proof: Groth16ProofPoints;
    depositRoot: string;
    nullifierHash: string[];
    totalClaimed: bigint;
    token: string;
    refundAmount: bigint;
    fee: bigint;
    relayer: string;
    refunder: string;
    tier: number;
};

export async function generateRefundProof(input: RefundProofInput): Promise<RefundProofResult> {
    const { slots, token, tier, depositPathElements, depositPathIndices, totalClaimed, fee, relayer, refunder } = input;
    if (!TIER_AUTH_DEPTH[tier]) throw new Error(`Unknown tier ${tier}`);
    if (slots.length !== tier) throw new Error(`Expected ${tier} refund slots, got ${slots.length}`);

    const poseidon = await getPoseidon();
    const hash = (values: bigint[]) => poseidon.hash(values);
    const hash2 = (a: bigint, b: bigint) => hash([a, b]);

    const depositSecretField = await secretStringToField(input.depositSecret);
    const depositorSecretHash = hash([depositSecretField]);

    const nullifiers = slots.map((s) => BigInt(s.nullifier));
    const secretHashes = slots.map((s) => BigInt(s.secretHash));
    const withdrawAmounts = slots.map((s) => BigInt(s.withdrawAmount));
    const tokenBig = BigInt(token);

    const nullifierHashes = nullifiers.map((n) => hash([n]));
    const authLeaves = secretHashes.map((secretHash, i) =>
        hash([withdrawAmounts[i], tokenBig, hash([secretHash, nullifiers[i]])]),
    );

    const authRoot = buildAuthTree(authLeaves, TIER_AUTH_DEPTH[tier], hash2).root;

    const depositLeaf = hash2(authRoot, depositorSecretHash);
    let depositRoot = depositLeaf;
    for (let l = 0; l < TREE_DEPTH; l += 1) {
        const bit = depositPathIndices[l];
        const sibling = BigInt(depositPathElements[l]);
        depositRoot = bit === 0 ? hash2(depositRoot, sibling) : hash2(sibling, depositRoot);
    }

    const totalWithdraw = withdrawAmounts.reduce((a, b) => a + b, 0n);
    const refundAmount = totalWithdraw - totalClaimed;
    if (refundAmount <= 0n) throw new Error('Nothing to refund: total allocations already fully claimed');
    if (fee * 1000n < refundAmount) {
        throw new Error(`Fee too low: minimum 0.1% of refundAmount (refundAmount=${refundAmount}, fee=${fee})`);
    }

    const circuitInput = {
        depositRoot: depositRoot.toString(),
        nullifierHash: nullifierHashes.map((nh) => nh.toString()),
        totalClaimed: totalClaimed.toString(),
        token: tokenBig.toString(),
        refundAmount: refundAmount.toString(),
        fee: fee.toString(),
        relayer: BigInt(relayer).toString(),
        refunder: BigInt(refunder).toString(),
        depositSecret: depositSecretField.toString(),
        nullifier: nullifiers.map((n) => n.toString()),
        secretHash: secretHashes.map((sh) => sh.toString()),
        withdrawAmount: withdrawAmounts.map((w) => w.toString()),
        depositPathElements: depositPathElements.map((x) => BigInt(x).toString()),
        depositPathIndices: depositPathIndices.map(String),
    };

    const proof = await groth16Prove(input.circuit, circuitInput);

    return {
        proof,
        depositRoot: depositRoot.toString(),
        nullifierHash: nullifierHashes.map(toHex64),
        totalClaimed,
        token,
        refundAmount,
        fee,
        relayer,
        refunder,
        tier,
    };
}
