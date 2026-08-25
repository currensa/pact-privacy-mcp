import { createHash } from 'node:crypto';

const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type PoseidonInstance = Awaited<ReturnType<typeof import('circomlibjs')['buildPoseidon']>>;
let poseidonInstance: PoseidonInstance | null = null;

export type Poseidon = {
    hash(values: bigint[]): bigint;
};

/** Lazily built Poseidon (BN254, circomlibjs) - same parameters as the GravArc circuits. */
export async function getPoseidon(): Promise<Poseidon> {
    if (!poseidonInstance) {
        const { buildPoseidon } = await import('circomlibjs');
        poseidonInstance = await buildPoseidon();
    }
    const instance = poseidonInstance;
    return {
        hash(values: bigint[]): bigint {
            return instance.F.toObject(instance(values)) as bigint;
        },
    };
}

export async function poseidonHash(values: bigint[]): Promise<bigint> {
    const poseidon = await getPoseidon();
    return poseidon.hash(values);
}

/** Deterministically maps an arbitrary string to a BN254 field element via SHA-256. */
export async function secretStringToField(secret: string): Promise<bigint> {
    const digest = createHash('sha256').update(new TextEncoder().encode(secret)).digest();
    let value = 0n;
    for (const byte of digest) value = (value << 8n) | BigInt(byte);
    return value % BN254_PRIME;
}

export function toHex64(value: bigint): string {
    return `0x${value.toString(16).padStart(64, '0')}`;
}
