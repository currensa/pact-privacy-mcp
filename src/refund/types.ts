import type { CanonicalAddress } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";

export type RefundEntry = { nullifier: string; secretHash: string; amount: string };

export type RefundContent = {
  token: CanonicalAddress;
  tokenSymbol?: string;
  decimals?: number;
  tier: CircuitTier;
  authRoot: string;
  depositLeaf: string;
  depositorSecretHash: string;
  refundEntries: RefundEntry[];
};

export type RefundPlan = {
  leafIndex: number;
  token: CanonicalAddress;
  tokenSymbol: string;
  decimals: number;
  tier: CircuitTier;
  depositLeaf: string;
  totalAllocated: string;
  totalClaimedAtPreparation: string;
  refundAmountAtPreparation: string;
  feeAtPreparation: string;
  netRefundAtPreparation: string;
  refunder: CanonicalAddress;
  relayer: CanonicalAddress;
  expectedTransactions: ["refund"];
};

export type RefundProofResult = {
  proof: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
  };
  depositRoot: bigint;
  nullifierHashes: `0x${string}`[];
  refundAmount: bigint;
  fee: bigint;
  token: CanonicalAddress;
  tier: CircuitTier;
  relayer: CanonicalAddress;
  refunder: CanonicalAddress;
};
