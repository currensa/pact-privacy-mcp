import type { CanonicalAddress } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";

export type WithdrawPlan = {
  allocationId: string;
  source: "payroll" | "defi";
  leafIndex: number;
  token: CanonicalAddress;
  tokenSymbol: string;
  decimals: number;
  tier: CircuitTier;
  allocationAmount: string;
  claimedAtPreparation: string;
  nonceAtPreparation: string;
  expectedAmount: string;
  fee: string;
  netAmount: string;
  recipient: CanonicalAddress;
  relayer: CanonicalAddress;
  expectedTransactions: ["withdraw"];
};

export type WithdrawProofResult = {
  proof: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
  };
  nullifierHash: `0x${string}`;
  depositRoot: bigint;
  claimedAmount: bigint;
  expectedAmount: bigint;
  fee: bigint;
  relayer: CanonicalAddress;
  recipient: CanonicalAddress;
  nonce: bigint;
  token: CanonicalAddress;
  tier: CircuitTier;
};
