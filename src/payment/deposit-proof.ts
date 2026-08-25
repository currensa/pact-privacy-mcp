import { getPoseidon, toHex64 } from './poseidon.js';
import { randomField } from './nacl-crypto.js';
import { groth16Prove, type CircuitFiles, type Groth16ProofPoints } from './prover.js';

const TREE_DEPTH = 20;
const TIER_AUTH_DEPTH: Record<number, number> = { 8: 3, 16: 4, 32: 5, 64: 6, 128: 7 };
/** Placeholder depositorSecretHash for non-refundable deposits (matches deposit.circom). */
const FAKE_DEPOSITOR_SECRET_HASH = BigInt('1'.repeat(64));

export function selectTier(count: number): number {
    for (const tier of [8, 16, 32, 64, 128]) if (count <= tier) return tier;
    throw new Error('Too many receivers (max 128)');
}

function buildAuthTree(leaves: bigint[], depth: number, hash2: (a: bigint, b: bigint) => bigint) {
    const size = 1 << depth;
    const tree = new Array<bigint>(2 * size).fill(0n);
    for (let i = 0; i < leaves.length; i += 1) tree[size + i] = leaves[i];
    for (let i = size - 1; i >= 1; i -= 1) tree[i] = hash2(tree[2 * i], tree[2 * i + 1]);
    return {
        root: tree[1],
        proof(idx: number): { pathElements: bigint[]; pathIndices: number[] } {
            const pathElements: bigint[] = [];
            const pathIndices: number[] = [];
            let nodeIdx = size + idx;
            while (nodeIdx > 1) {
                const isRight = nodeIdx & 1;
                pathElements.push(tree[isRight ? nodeIdx - 1 : nodeIdx + 1]);
                pathIndices.push(isRight);
                nodeIdx >>= 1;
            }
            return { pathElements, pathIndices };
        },
    };
}

export type DepositReceiver = {
    address: string;
    secretHash: string;
    encPubkey: string;
    amount: bigint;
};

export type DepositProofResult = {
    proof: Groth16ProofPoints;
    tier: number;
    newDepositRoot: string;
    authRoot: string;
    depositLeaf: string;
    depositorSecretHash: string;
    totalAmount: bigint;
    leafIndex: number;
    receivers: {
        address: string;
        nullifier: string;
        amount: string;
        encPubkey: string;
        authPathElements: string[];
        authPathIndices: number[];
    }[];
    depositPathElements: string[];
    depositPathIndices: number[];
    refundSlots: { nullifier: string; secretHash: string; withdrawAmount: string }[];
};

export async function generateDepositProof(
    receivers: DepositReceiver[],
    token: bigint,
    circuit: CircuitFiles,
    depositPath: { nextIndex: number; siblings: string[] },
    refundable: boolean,
    depositorSecretHash: string | null,
): Promise<DepositProofResult> {
    const tier = selectTier(receivers.length);
    const authDepth = TIER_AUTH_DEPTH[tier];

    const poseidon = await getPoseidon();
    const hash = (values: bigint[]) => poseidon.hash(values);
    const hash2 = (a: bigint, b: bigint) => hash([a, b]);

    const nullifiers = receivers.map((r) => hash([BigInt(r.encPubkey.startsWith('0x') ? r.encPubkey : `0x${r.encPubkey}`), randomField()]));
    const amounts = receivers.map((r) => r.amount);
    const totalAmount = amounts.reduce((a, b) => a + b, 0n);
    const commitments = receivers.map((r, i) => hash([BigInt(r.secretHash), nullifiers[i]]));
    const authLeavesRaw = commitments.map((c, i) => hash([amounts[i], token, c]));

    const authLeaves = [...authLeavesRaw];
    const amountsPadded = [...amounts];
    const commitmentsPadded = [...commitments];
    const paddedSlots: { nullifier: bigint; secretHash: bigint; withdrawAmount: bigint }[] = [];
    while (authLeaves.length < tier) {
        const withdrawAmount = 0n;
        amountsPadded.push(withdrawAmount);
        if (refundable) {
            const paddedNullifier = hash([randomField()]);
            const paddedSecretHash = hash([randomField(), 1n]);
            const commitment = hash([paddedSecretHash, paddedNullifier]);
            authLeaves.push(hash([withdrawAmount, token, commitment]));
            commitmentsPadded.push(commitment);
            paddedSlots.push({ nullifier: paddedNullifier, secretHash: paddedSecretHash, withdrawAmount });
        } else {
            authLeaves.push(hash([0n, token, 0n]));
            commitmentsPadded.push(0n);
        }
    }

    const authTree = buildAuthTree(authLeaves, authDepth, hash2);
    const authRoot = authTree.root;
    const authPaths = receivers.map((_, i) => authTree.proof(i));

    const depositorSecretHashBig = refundable ? BigInt(depositorSecretHash ?? '0') : FAKE_DEPOSITOR_SECRET_HASH;
    const depositLeaf = hash2(authRoot, depositorSecretHashBig);

    const siblings = depositPath.siblings.map(BigInt);
    const leafIndex = depositPath.nextIndex;

    const zeros: bigint[] = [0n];
    for (let l = 0; l < TREE_DEPTH; l += 1) zeros.push(hash2(zeros[l], zeros[l]));

    let oldRootNode = 0n;
    for (let l = 0; l < TREE_DEPTH; l += 1) {
        const bit = (leafIndex >> l) & 1;
        const sib = bit === 1 ? siblings[l] : zeros[l];
        oldRootNode = bit === 0 ? hash2(oldRootNode, sib) : hash2(sib, oldRootNode);
    }
    const oldRoot = oldRootNode;

    const newFilledSubtrees = [...siblings];
    let node = depositLeaf;
    for (let l = 0; l < TREE_DEPTH; l += 1) {
        if ((leafIndex >> l) & 1) {
            node = hash2(newFilledSubtrees[l], node);
        } else {
            newFilledSubtrees[l] = node;
            node = hash2(node, zeros[l]);
        }
    }
    const newDepositRoot = node;

    const depositPathIndices: number[] = [];
    const depositPathElements: bigint[] = [];
    for (let l = 0; l < TREE_DEPTH; l += 1) {
        const bit = (leafIndex >> l) & 1;
        depositPathIndices.push(bit);
        depositPathElements.push(bit === 0 ? zeros[l] : siblings[l]);
    }

    const input = {
        newDepositRoot: newDepositRoot.toString(),
        oldRoot: oldRoot.toString(),
        depositLeaf: depositLeaf.toString(),
        leafIndex: leafIndex.toString(),
        totalAmount: totalAmount.toString(),
        token: token.toString(),
        oldFilledSubtrees: siblings.map((x) => x.toString()),
        commitments: commitmentsPadded.map((c) => c.toString()),
        amounts: amountsPadded.map((a) => a.toString()),
        depositorSecretHash: depositorSecretHashBig.toString(),
        canRefund: (refundable ? 1n : 0n).toString(),
    };

    const proof = await groth16Prove(circuit, input);

    return {
        proof,
        tier,
        newDepositRoot: toHex64(newDepositRoot),
        authRoot: toHex64(authRoot),
        depositLeaf: toHex64(depositLeaf),
        depositorSecretHash: toHex64(depositorSecretHashBig),
        totalAmount,
        leafIndex,
        receivers: receivers.map((r, i) => ({
            address: r.address,
            nullifier: toHex64(nullifiers[i]),
            amount: r.amount.toString(),
            encPubkey: r.encPubkey,
            authPathElements: authPaths[i].pathElements.map(toHex64),
            authPathIndices: authPaths[i].pathIndices,
        })),
        depositPathElements: depositPathElements.map(toHex64),
        depositPathIndices,
        refundSlots: [
            ...receivers.map((r, i) => ({
                nullifier: toHex64(nullifiers[i]),
                secretHash: r.secretHash,
                withdrawAmount: r.amount.toString(),
            })),
            ...paddedSlots.map((s) => ({
                nullifier: toHex64(s.nullifier),
                secretHash: toHex64(s.secretHash),
                withdrawAmount: s.withdrawAmount.toString(),
            })),
        ],
    };
}
