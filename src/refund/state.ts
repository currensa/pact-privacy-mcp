import { poseidonHash } from "../proof/poseidon.js";
import type { Web3Service } from "../web3/service.js";
import type { RefundContent } from "./types.js";

export async function refundState(web3: Web3Service, content: RefundContent): Promise<{
  nullifierHashes: `0x${string}`[];
  claimedAmounts: bigint[];
  totalAllocated: bigint;
  totalClaimed: bigint;
  refundAmount: bigint;
  fee: bigint;
}> {
  const nullifierHashes = await Promise.all(content.refundEntries.map(async (entry) => {
    const value = await poseidonHash([BigInt(entry.nullifier)]);
    return `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
  }));
  const states = await Promise.all(nullifierHashes.map((hash) => web3.claimedState(hash)));
  if (states.some((state) => state.refunded)) throw new Error("This deposit has already been refunded on-chain");
  const claimedAmounts = states.map((state) => state.claimed);
  const totalAllocated = content.refundEntries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  const totalClaimed = claimedAmounts.reduce((sum, amount) => sum + amount, 0n);
  if (totalClaimed > totalAllocated) throw new Error("Claimed amount exceeds the deposited allocations");
  const refundAmount = totalAllocated - totalClaimed;
  if (refundAmount <= 0n) throw new Error("Nothing remains to refund");
  const fee = (refundAmount + 999n) / 1000n;
  return { nullifierHashes, claimedAmounts, totalAllocated, totalClaimed, refundAmount, fee };
}
