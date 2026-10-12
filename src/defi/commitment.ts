import { AbiCoder, concat, getBytes, keccak256 } from "ethers";
import type { CanonicalAddress } from "../core/types.js";
import type { DefiCall } from "./types.js";

const coder = AbiCoder.defaultAbiCoder();

export function computeDefiCommitment(defiFee: bigint, calls: DefiCall[]): CanonicalAddress {
  const hashes = calls.map((call) => keccak256(coder.encode(
    ["address", "uint256", "bytes"],
    [call.target, call.value, call.data],
  )));
  const callsHash = hashes.length === 0 ? `0x${"00".repeat(32)}` : keccak256(concat(hashes.map((hash) => getBytes(hash))));
  return `0x${keccak256(coder.encode(["uint256", "bytes32"], [defiFee, callsHash])).slice(-40)}`;
}
