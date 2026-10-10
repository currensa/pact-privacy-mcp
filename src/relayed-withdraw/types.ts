import type { CanonicalAddress } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";

export type RelayedWithdrawPlan = {
  allocationId: string;
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
  maximumFee?: string;
  networkFee: string;
  serviceFee: string;
  netAmount: string;
  recipient: CanonicalAddress;
  relayer: CanonicalAddress;
  relayerUrl: string;
  quoteId: string;
  quoteExpiresAt: string;
  gravArc: CanonicalAddress;
  expectedTransactions: ["relayed-withdraw"];
};
