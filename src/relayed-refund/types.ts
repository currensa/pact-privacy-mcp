import type { CanonicalAddress } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";

export type RelayedRefundPlan = {
  leafIndex: number;
  token: CanonicalAddress;
  tokenSymbol: string;
  decimals: number;
  tier: CircuitTier;
  depositLeaf: string;
  totalAllocated: string;
  totalClaimedAtPreparation: string;
  refundAmount: string;
  fee: string;
  maximumFee?: string;
  networkFee: string;
  serviceFee: string;
  netRefund: string;
  refunder: CanonicalAddress;
  relayer: CanonicalAddress;
  relayerUrl: string;
  quoteId: string;
  quoteExpiresAt: string;
  gravArc: CanonicalAddress;
  expectedTransactions: ["relayed-refund"];
};
