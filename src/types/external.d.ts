declare module "circomlibjs" {
  export function buildPoseidon(): Promise<unknown>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasmPath: string, zkeyPath: string): Promise<unknown>;
  };
}
