import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";
import type { ChainFamily } from "../core/types.js";

export type ApiKeyAction =
  | "api-key-create"
  | "api-key-grant"
  | "api-key-remove-grant"
  | "api-key-rotate"
  | "api-key-revoke";

function textHash(value: string): string {
  return keccak256(toUtf8Bytes(value));
}

export function apiKeyCreatePayloadHash(value: {
  name: string;
  scopes: string[];
  expiresAt: number | null;
  address: string;
  family: ChainFamily;
}): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "uint256", "address", "bytes32"],
    [
      textHash(value.name),
      textHash([...value.scopes].sort().join(",")),
      BigInt(value.expiresAt ?? 0),
      getAddress(value.address),
      textHash(value.family),
    ],
  ));
}

export function apiKeyManagePayloadHash(value: {
  operation: Exclude<ApiKeyAction, "api-key-create">;
  keyId: string;
  address: string;
  family: ChainFamily;
}): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "address", "bytes32"],
    [textHash(value.operation), textHash(value.keyId), getAddress(value.address), textHash(value.family)],
  ));
}
