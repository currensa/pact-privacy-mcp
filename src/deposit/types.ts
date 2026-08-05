import type { CanonicalAddress } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";

export type DepositReceiver = {
  address: CanonicalAddress;
  secretHash: string;
  encPubkey: string;
  amount: bigint;
};

export type DepositProofResult = {
  proof: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
  };
  tier: CircuitTier;
  newDepositRoot: string;
  oldDepositRoot: string;
  authRoot: string;
  depositLeaf: string;
  depositorSecretHash: string;
  canRefund: 0 | 1;
  totalAmount: bigint;
  leafIndex: number;
  receivers: Array<{
    address: CanonicalAddress;
    nullifier: string;
    amount: string;
    encPubkey: string;
    authPathElements: string[];
    authPathIndices: number[];
  }>;
  refundEntries: Array<{ nullifier: string; secretHash: string; amount: string }>;
};

export type DepositPlan = {
  token: CanonicalAddress;
  tokenSymbol: string;
  decimals: number;
  native: boolean;
  recipients: Array<{ address: CanonicalAddress; amount: string }>;
  registryDigest: string;
  totalAmount: string;
  tier: CircuitTier;
  refund: boolean;
  depositorRegistryDigest?: string;
  allowance: { current: string; required: string; approvalRequired: boolean };
  expectedTransactions: string[];
};
