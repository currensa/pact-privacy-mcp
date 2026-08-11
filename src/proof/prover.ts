import { CircuitArtifactCache, type CircuitName, type CircuitTier } from "./artifact-cache.js";

export type Groth16Proof = {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  publicSignals: string[];
  bundleVersion: string;
};

export class LocalProofService {
  constructor(private readonly artifacts: CircuitArtifactCache) {}

  async prepare(circuit: CircuitName, tier: CircuitTier): Promise<void> {
    await this.artifacts.bundle(circuit, tier);
  }

  async prove(circuit: CircuitName, tier: CircuitTier, input: Record<string, unknown>): Promise<Groth16Proof> {
    const { wasmPath, zkeyPath, bundleVersion } = await this.artifacts.bundle(circuit, tier);
    const { groth16 } = await import("snarkjs");
    const result = await groth16.fullProve(input, wasmPath, zkeyPath) as {
      proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
      publicSignals: string[];
    };
    const a0 = result.proof.pi_a[0];
    const a1 = result.proof.pi_a[1];
    const b00 = result.proof.pi_b[0]?.[0];
    const b01 = result.proof.pi_b[0]?.[1];
    const b10 = result.proof.pi_b[1]?.[0];
    const b11 = result.proof.pi_b[1]?.[1];
    const c0 = result.proof.pi_c[0];
    const c1 = result.proof.pi_c[1];
    if (!a0 || !a1 || !b00 || !b01 || !b10 || !b11 || !c0 || !c1) throw new Error("Malformed Groth16 proof");
    return {
      pA: [a0, a1],
      pB: [[b01, b00], [b11, b10]],
      pC: [c0, c1],
      publicSignals: result.publicSignals,
      bundleVersion,
    };
  }

  async close(): Promise<void> {
    const globals = globalThis as typeof globalThis & {
      curve_bn128?: { terminate?: () => Promise<void> } | null;
      curve_bls12381?: { terminate?: () => Promise<void> } | null;
    };
    for (const curve of [globals.curve_bn128, globals.curve_bls12381]) {
      if (curve?.terminate) await curve.terminate();
    }
  }
}
