import { getAddress, isAddress } from "ethers";
import { TronWeb } from "tronweb";
import type { CanonicalAddress, ChainFamily } from "../core/types.js";

const CANONICAL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRON_HEX_ADDRESS = /^(?:0x)?41[0-9a-fA-F]{40}$/;

export function isCanonicalAddress(value: string): value is CanonicalAddress {
  return CANONICAL_ADDRESS.test(value);
}

export function canonicalFromTronAddress(value: string): CanonicalAddress {
  if (isCanonicalAddress(value)) return value.toLowerCase() as CanonicalAddress;
  let hex: string;
  if (TRON_HEX_ADDRESS.test(value)) {
    hex = value.replace(/^0x/i, "");
  } else {
    try {
      hex = TronWeb.address.toHex(value);
    } catch {
      throw new Error(`Invalid TRON address: ${value}`);
    }
  }
  if (!/^41[0-9a-fA-F]{40}$/.test(hex)) throw new Error(`Invalid TRON address: ${value}`);
  return `0x${hex.slice(2).toLowerCase()}`;
}

export function normalizeAddress(value: string, family: ChainFamily): CanonicalAddress {
  if (family === "tron") return canonicalFromTronAddress(value);
  if (!isAddress(value)) throw new Error(`Invalid EVM address: ${value}`);
  return getAddress(value).toLowerCase() as CanonicalAddress;
}

export function tronHexFromCanonical(value: string): string {
  if (!isCanonicalAddress(value)) throw new Error(`Invalid canonical address: ${value}`);
  return `41${value.slice(2).toLowerCase()}`;
}

export function tronBase58FromCanonical(value: string): string {
  return TronWeb.address.fromHex(tronHexFromCanonical(value));
}

export function displayAddress(value: string, family: ChainFamily): string {
  const canonical = normalizeAddress(value, family);
  return family === "tron" ? tronBase58FromCanonical(canonical) : getAddress(canonical);
}
