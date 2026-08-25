/**
 * Shared Groth16 proving helper. Downloads wasm/zkey circuit files into an
 * in-memory cache and runs snarkjs fullProve, returning the proof with the
 * pB coordinate flip the GravArc contract verifiers expect.
 */

export type Groth16ProofPoints = {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
};

export type CircuitFiles = {
    wasmUrl: string;
    zkeyUrl: string;
    wasmSha256: string | null;
    zkeySha256: string | null;
};

const circuitCache = new Map<string, Uint8Array>();

async function fetchCircuit(url: string): Promise<Uint8Array> {
    const cached = circuitCache.get(url);
    if (cached) return cached;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch circuit file: ${url} (${response.status})`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    circuitCache.set(url, buffer);
    return buffer;
}

export async function groth16Prove(
    files: CircuitFiles,
    input: Record<string, unknown>,
): Promise<Groth16ProofPoints> {
    const [wasm, zkey] = await Promise.all([fetchCircuit(files.wasmUrl), fetchCircuit(files.zkeyUrl)]);
    const { groth16 } = await import('snarkjs');
    const { proof } = await groth16.fullProve(
        input,
        wasm as unknown as string,
        { type: 'mem', data: zkey } as unknown as string,
    ) as { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] } };
    const pA = proof.pi_a.slice(0, 2) as [string, string];
    const pB = proof.pi_b.slice(0, 2) as [[string, string], [string, string]];
    const pC = proof.pi_c.slice(0, 2) as [string, string];
    return {
        pA,
        // The contract verifiers expect the pB coordinates flipped.
        pB: [[pB[0][1], pB[0][0]], [pB[1][1], pB[1][0]]],
        pC,
    };
}
