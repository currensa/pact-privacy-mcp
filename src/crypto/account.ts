import { createHash } from "node:crypto";
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import nacl from "tweetnacl";
import type { ChainFamily } from "../core/types.js";
import { LocalSigner } from "../wallet/local-signer.js";
import { poseidonHash, secretStringToField } from "../proof/poseidon.js";

function hexToBytes(hex: string): Uint8Array {
  const value = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) throw new Error("Invalid hexadecimal value");
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export async function deriveEncryptionKeyPair(
  password: string,
  signer: LocalSigner,
  family: ChainFamily,
): Promise<nacl.BoxKeyPair> {
  const signature = await signer.signEncryptionPassword(password, family);
  const seed = createHash("sha256").update(hexToBytes(signature)).digest();
  return nacl.box.keyPair.fromSecretKey(seed);
}

export function encryptOwnSecret(secret: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(new TextEncoder().encode(secret), nonce, key);
  return `${bytesToHex(nonce)}:${bytesToHex(ciphertext)}`;
}

export function decryptOwnSecret(encrypted: string, key: Uint8Array): string {
  const [nonceHex, ciphertextHex, extra] = encrypted.split(":");
  if (!nonceHex || !ciphertextHex || extra !== undefined) throw new Error("Invalid encrypted secret format");
  const plaintext = nacl.secretbox.open(hexToBytes(ciphertextHex), hexToBytes(nonceHex), key);
  if (!plaintext) throw new Error("Decryption failed; check the password and account family");
  return new TextDecoder().decode(plaintext);
}

export async function secretHash(secret: string): Promise<`0x${string}`> {
  const field = await secretStringToField(secret);
  const hash = await poseidonHash([field]);
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

export function accountPayloadHash(
  encryptedSecret: string,
  hash: `0x${string}`,
  encryptionPublicKey: string,
): `0x${string}` {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32"],
    [keccak256(toUtf8Bytes(encryptedSecret)), hash, keccak256(toUtf8Bytes(encryptionPublicKey))],
  )) as `0x${string}`;
}

export async function buildAccountRegistration(
  signer: LocalSigner,
  family: ChainFamily,
  password: string,
  secret: string,
): Promise<{
  encryptedSecret: string;
  secretHash: `0x${string}`;
  encPubkey: string;
  payloadHash: `0x${string}`;
}> {
  const keyPair = await deriveEncryptionKeyPair(password, signer, family);
  const encryptedSecret = encryptOwnSecret(secret, keyPair.secretKey);
  const hash = await secretHash(secret);
  const encPubkey = bytesToHex(keyPair.publicKey);
  return {
    encryptedSecret,
    secretHash: hash,
    encPubkey,
    payloadHash: accountPayloadHash(encryptedSecret, hash, encPubkey),
  };
}
