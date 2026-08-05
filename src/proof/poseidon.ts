const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type Poseidon = ((inputs: bigint[]) => unknown) & {
  F: { toObject(value: unknown): bigint };
};

let poseidonPromise: Promise<Poseidon> | undefined;

async function getPoseidon(): Promise<Poseidon> {
  poseidonPromise ??= import("circomlibjs")
    .then(async ({ buildPoseidon }) => await buildPoseidon() as Poseidon);
  return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  return poseidon.F.toObject(poseidon(inputs));
}

export async function secretStringToField(secret: string): Promise<bigint> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  let value = 0n;
  for (const byte of new Uint8Array(digest)) value = (value << 8n) | BigInt(byte);
  return value % BN254_PRIME;
}
