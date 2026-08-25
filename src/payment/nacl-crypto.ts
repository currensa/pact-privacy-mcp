import { createHash, randomBytes } from 'node:crypto';
import type { Wallet } from 'ethers';
import type * as Nacl from 'tweetnacl';

/** tweetnacl is CJS; resolve the default export under both Node ESM interop modes. */
async function loadNacl(): Promise<typeof Nacl> {
    const mod: any = await import('tweetnacl');
    return mod.default ?? mod;
}

function hexToBytes(hex: string): Uint8Array {
    const value = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives a NaCl box key pair from a wallet EIP-712 signature over `password`
 * (same scheme as the web app's deriveNaclKeyPair - cross-device reproducible).
 */
export async function deriveNaclKeyPair(password: string, wallet: Wallet): Promise<Uint8Array> {
    const nacl = await loadNacl();
    const signature = await wallet.signTypedData(
        { name: 'GravArc', version: '1' },
        { EncryptionKey: [{ name: 'password', type: 'string' }] },
        { password },
    );
    const seed = createHash('sha256').update(hexToBytes(signature)).digest();
    return nacl.box.keyPair.fromSecretKey(new Uint8Array(seed)).secretKey;
}

/** Symmetric decryption of the user's own secret ("<nonce>:<ciphertext>" hex). */
export async function secretboxDecrypt(encrypted: string, key: Uint8Array): Promise<string> {
    const nacl = await loadNacl();
    const [nonceHex, ciphertextHex] = encrypted.split(':');
    const plain = nacl.secretbox.open(hexToBytes(ciphertextHex), hexToBytes(nonceHex), key);
    if (!plain) throw new Error('Decryption failed - wrong password or corrupted data');
    return new TextDecoder().decode(plain);
}

/** Encrypts `message` for a recipient identified by their NaCl public key hex ("<ephPub>:<nonce>:<ct>"). */
export async function naclEncrypt(message: string, recipientPubKeyHex: string): Promise<string> {
    const nacl = await loadNacl();
    const pubKey = recipientPubKeyHex.startsWith('0x') ? recipientPubKeyHex.slice(2) : recipientPubKeyHex;
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(
        new TextEncoder().encode(message),
        nonce,
        hexToBytes(pubKey),
        ephemeral.secretKey,
    );
    return `${bytesToHex(ephemeral.publicKey)}:${bytesToHex(nonce)}:${bytesToHex(ciphertext)}`;
}

/** Decrypts a message produced by naclEncrypt using a derived secret key. */
export async function naclDecrypt(encrypted: string, key: Uint8Array): Promise<string> {
    const nacl = await loadNacl();
    const [ephemeralPubKeyHex, nonceHex, ciphertextHex] = encrypted.split(':');
    const plain = nacl.box.open(
        hexToBytes(ciphertextHex),
        hexToBytes(nonceHex),
        hexToBytes(ephemeralPubKeyHex),
        key,
    );
    if (!plain) throw new Error('Decryption failed - wrong key or corrupted message');
    return new TextDecoder().decode(plain);
}

export function randomField(): bigint {
    return BigInt(`0x${randomBytes(31).toString('hex')}`);
}
