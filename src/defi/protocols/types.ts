import type { ChainRuntime } from "../../chain/runtime.js";
import type { ChainDetails, CanonicalAddress, ChainFamily } from "../../core/types.js";
import type { DefiCall, DefiProtocolSnapshot, DefiQuote } from "../types.js";

export type DefiQuoteRequest = {
  chain: ChainDetails;
  runtime: ChainRuntime;
  protocol: DefiProtocolSnapshot;
  inputToken: CanonicalAddress;
  outputToken: CanonicalAddress;
  amount: bigint;
  inputDecimals: number;
  outputDecimals: number;
  slippageBips: bigint;
};

export type DefiBuildRequest = {
  chainId: number;
  family: ChainFamily;
  protocol: DefiProtocolSnapshot;
  inputToken: CanonicalAddress;
  outputToken: CanonicalAddress;
  amount: bigint;
  quote: DefiQuote;
  pureRouter: CanonicalAddress;
  destination: CanonicalAddress;
  slippageBips: bigint;
  requiredOutput?: bigint;
};

export type DefiBuildResult = {
  calls: DefiCall[];
  outputLocation: "pure-router" | "recipient";
};

export type DefiProtocolAdapter = {
  type: string;
  quote(request: DefiQuoteRequest): Promise<DefiQuote>;
  buildSwapCalls(request: DefiBuildRequest): DefiBuildResult;
};
