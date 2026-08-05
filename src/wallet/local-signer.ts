import { randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import { Trx, TronWeb } from "tronweb";
import { canonicalFromTronAddress } from "../chain/address.js";
import type { CanonicalAddress, ChainFamily } from "../core/types.js";
import { normalizePrivateKey } from "../config/env.js";

export type AuthorizationChallenge = {
  nonce: string;
  expiresAt: number;
  action: string;
  payloadHash: string;
  family: ChainFamily;
  domain: { name: string; version: string };
};

const AUTH_TYPES = {
  WalletAuthorization: [
    { name: "action", type: "string" },
    { name: "family", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "payloadHash", type: "bytes32" },
  ],
};

export function tronAuthorizationMessage(value: AuthorizationChallenge): string {
  return [
    `${value.domain.name} Wallet Authorization`,
    `Version: ${value.domain.version}`,
    `Action: ${value.action}`,
    `Family: ${value.family}`,
    `Nonce: ${value.nonce.toLowerCase()}`,
    `Expires At: ${value.expiresAt}`,
    `Payload Hash: ${value.payloadHash.toLowerCase()}`,
  ].join("\n");
}

export class LocalSigner {
  readonly privateKey: string;
  readonly evmWallet: Wallet;

  constructor(privateKey: string) {
    this.privateKey = normalizePrivateKey(privateKey);
    this.evmWallet = new Wallet(this.privateKey);
  }

  static generate(): LocalSigner {
    return new LocalSigner(`0x${randomBytes(32).toString("hex")}`);
  }

  address(family: ChainFamily): CanonicalAddress {
    if (family === "evm") return this.evmWallet.address.toLowerCase() as CanonicalAddress;
    const base58 = TronWeb.address.fromPrivateKey(this.privateKey.slice(2));
    if (!base58) throw new Error("Could not derive TRON address from private key");
    return canonicalFromTronAddress(base58);
  }

  displayAddress(family: ChainFamily): string {
    if (family === "evm") return this.evmWallet.address;
    const address = TronWeb.address.fromPrivateKey(this.privateKey.slice(2));
    if (!address) throw new Error("Could not derive TRON address from private key");
    return address;
  }

  async signChallenge(challenge: AuthorizationChallenge): Promise<string> {
    if (challenge.family === "tron") {
      return Trx.signMessageV2(tronAuthorizationMessage(challenge), this.privateKey.slice(2));
    }
    return this.evmWallet.signTypedData(
      challenge.domain,
      AUTH_TYPES,
      {
        action: challenge.action,
        family: challenge.family,
        nonce: challenge.nonce,
        expiresAt: BigInt(challenge.expiresAt),
        payloadHash: challenge.payloadHash,
      },
    );
  }

  async signEncryptionPassword(password: string, family: ChainFamily): Promise<string> {
    if (family === "tron") {
      const payload = new TextEncoder().encode(`GravArc TRON Encryption Key v1\n${password}`);
      return Trx.signMessageV2(`0x${Buffer.from(payload).toString("hex")}`, this.privateKey.slice(2));
    }
    return this.evmWallet.signTypedData(
      { name: "GravArc", version: "1" },
      { EncryptionKey: [{ name: "password", type: "string" }] },
      { password },
    );
  }
}
