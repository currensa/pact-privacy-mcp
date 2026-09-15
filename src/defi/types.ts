import type { CanonicalAddress } from "../core/types.js";
import type { CircuitTier } from "../proof/artifact-cache.js";

export type DefiCall = { target: CanonicalAddress; value: bigint; data: `0x${string}` };

export type DefiProtocolSnapshot = {
  name: string;
  type: string;
  outputBehavior: "fixed" | "variable";
  address: CanonicalAddress;
  helpContracts?: Record<string, CanonicalAddress>;
};

export type DefiRecipient = { address: CanonicalAddress; amount: string };

export type DefiPlan = {
  allocationId: number;
  leafIndex: number;
  tier: CircuitTier;
  allocationAmount: string;
  claimedAtPreparation: string;
  nonceAtPreparation: string;
  inputToken: CanonicalAddress;
  inputTokenSymbol: string;
  inputDecimals: number;
  outputToken: CanonicalAddress;
  outputTokenSymbol: string;
  outputDecimals: number;
  protocol: DefiProtocolSnapshot;
  swapAmount: string;
  minimumOutput: string;
  estimatedOutput: string;
  slippageBips: string;
  privateRedeposit: boolean;
  excessRecipient?: CanonicalAddress;
  destination?: CanonicalAddress;
  recipients?: DefiRecipient[];
  registryDigest?: string;
  refund: boolean;
  depositorRegistryDigest?: string;
  defiFee: string;
  totalWithdrawal: string;
  expectedTransactions: string[];
};

export type RelayedDefiPlan = Omit<DefiPlan, "defiFee" | "totalWithdrawal" | "expectedTransactions"> & {
  defiFee: string;
  networkFee: string;
  serviceFee: string;
  maximumFee?: string;
  withdrawalBudget: string;
  totalWithdrawal: string;
  relayer: CanonicalAddress;
  relayerUrl: string;
  quoteId: string;
  quoteExpiresAt: string;
  defiRouter: CanonicalAddress;
  expectedTransactions: ["relayed-defi"];
};

export type DefiQuote = {
  amountIn: bigint;
  estimatedOutput: bigint;
  minimumOutput: bigint;
  routeLabel: string;
  payload?: unknown;
};
