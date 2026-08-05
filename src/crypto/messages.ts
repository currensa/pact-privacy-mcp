import nacl from "tweetnacl";
import { bytesToHex } from "./account.js";

function hexToBytes(value: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal value");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

export function encryptMessage(message: string, recipientPublicKey: string): string {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    new TextEncoder().encode(message),
    nonce,
    hexToBytes(recipientPublicKey),
    ephemeral.secretKey,
  );
  return `${bytesToHex(ephemeral.publicKey)}:${bytesToHex(nonce)}:${bytesToHex(ciphertext)}`;
}

export function decryptMessage(encrypted: string, secretKey: Uint8Array): string {
  const [ephemeralHex, nonceHex, ciphertextHex, extra] = encrypted.split(":");
  if (!ephemeralHex || !nonceHex || !ciphertextHex || extra !== undefined) {
    throw new Error("Invalid encrypted message format");
  }
  const plaintext = nacl.box.open(
    hexToBytes(ciphertextHex),
    hexToBytes(nonceHex),
    hexToBytes(ephemeralHex),
    secretKey,
  );
  if (!plaintext) throw new Error("Message decryption failed");
  return new TextDecoder().decode(plaintext);
}
