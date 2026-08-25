import { getPoseidon, secretStringToField, toHex64 } from './poseidon.js';
import { groth16Prove, type CircuitFiles, type Groth16ProofPoints } from './prover.js';

const TREE_DEPTH = 20;
const TIER_AUTH_DEPTH: Record<number, number> = { 8: 3, 16: 4, 32: 5, 64: 6, 128: 7 };

export type WithdrawInfo = {
    nullifier: string;
    amount: string;
    token: string;
    authRoot: string;
    depositorSecretHash: string;
    authPathElements: string[];
    authPathIndices: number[];
    leafIndex: number;
    depositPathElements: string[];
    depositPathIndices: number[];
    tier: number;
};

export type WithdrawProofResult = {
    proof: Groth16ProofPoints;
    nullifierHash: string;
    depositRoot: bigint;
    claimedAmount: bigint;
    expectedAmount: bigint;
    fee: bigint;
    relayer: string;
    nonce: bigint;
    token: string;
    tier: number;
};

export async function computeNullifierHash(nullifier: string): Promise<string> {
    const poseidon = await getPoseidon();
    return toHex64(poseidon.hash([BigInt(nullifier)]));
}

export async function generateWithdrawProof(
    info: WithdrawInfo,
    rawSecret: string,
    recipient: string,
    fee: bigint,
    circuit: CircuitFiles,
    claimedAmount = 0n,
    nonce = 0n,
    expectedAmountOverride?: bigint,
    relayerOverride?: string,
): Promise<WithdrawProofResult> {
    const poseidon = await getPoseidon();
    const hash = (values: bigint[]) => poseidon.hash(values);
    const hash2 = (a: bigint, b: bigint) => hash([a, b]);

    const nullifier = BigInt(info.nullifier);
    const withdrawAmount = BigInt(info.amount);
    const authRoot = BigInt(info.authRoot);
    const depositorSecretHash = BigInt(info.depositorSecretHash);
    const tier = info.tier;
    if (!TIER_AUTH_DEPTH[tier]) throw new Error(`Unknown tier ${tier}`);

    const nullifierHash = hash([nullifier]);

    // depositLeaf = Poseidon(authRoot, depositorSecretHash); depositRoot is rebuilt
    // by walking the deposit path back from the leaf.
    const depositLeaf = hash2(authRoot, depositorSecretHash);
    let depositRoot = depositLeaf;
    for (let l = 0; l < TREE_DEPTH; l += 1) {
        const bit = info.depositPathIndices[l];
        const sibling = BigInt(info.depositPathElements[l]);
        depositRoot = bit === 0 ? hash2(depositRoot, sibling) : hash2(sibling, depositRoot);
    }

    const remaining = withdrawAmount - claimedAmount;
    if (remaining <= 0n) throw new Error('Nothing left to claim for this receiver');
    const expectedAmount = expectedAmountOverride ?? remaining;
    if (expectedAmount <= 0n) throw new Error('Expected amount must be positive');
    if (expectedAmount > remaining) throw new Error('Expected amount exceeds remaining allocation');

    const relayer = relayerOverride ?? recipient;
    const secretField = await secretStringToField(rawSecret);

    const input = {
        depositRoot: depositRoot.toString(),
        nullifierHash: nullifierHash.toString(),
        receiver: BigInt(recipient).toString(),
        claimedAmount: claimedAmount.toString(),
        token: BigInt(info.token).toString(),
        expectedAmount: expectedAmount.toString(),
        fee: fee.toString(),
        relayer: BigInt(relayer).toString(),
        nonce: nonce.toString(),
        authRoot: authRoot.toString(),
        depositorSecretHash: depositorSecretHash.toString(),
        nullifier: nullifier.toString(),
        secret: secretField.toString(),
        withdrawAmount: withdrawAmount.toString(),
        authPathElements: info.authPathElements.map((x) => BigInt(x).toString()),
        authPathIndices: info.authPathIndices.map(String),
        depositPathElements: info.depositPathElements.map((x) => BigInt(x).toString()),
        depositPathIndices: info.depositPathIndices.map(String),
    };

    const proof = await groth16Prove(circuit, input);

    return {
        proof,
        nullifierHash: toHex64(nullifierHash),
        depositRoot,
        claimedAmount,
        expectedAmount,
        fee,
        relayer,
        nonce,
        token: info.token,
        tier,
    };
}
