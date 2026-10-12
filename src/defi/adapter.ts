import { normalizeAddress } from "../chain/address.js";
import type { ChainDetails } from "../core/types.js";
import { kuruAdapter } from "./protocols/kuru.js";
import { mockSwapAdapter } from "./protocols/mockSwap.js";
import { sunSwapV4Adapter } from "./protocols/sunSwapV4.js";
import type { DefiBuildRequest, DefiProtocolAdapter, DefiQuoteRequest } from "./protocols/types.js";
import { uniswapV3Adapter } from "./protocols/uniswapV3.js";
import type { DefiProtocolSnapshot } from "./types.js";

const adapters = new Map<string, DefiProtocolAdapter>([
  kuruAdapter,
  mockSwapAdapter,
  sunSwapV4Adapter,
  uniswapV3Adapter,
].map((adapter) => [adapter.type, adapter]));

function adapterFor(type: string): DefiProtocolAdapter {
  const adapter = adapters.get(type);
  if (!adapter) throw new Error(`Unsupported DeFi protocol type: ${type}`);
  return adapter;
}

export function protocolSnapshot(chain: ChainDetails, value: string): DefiProtocolSnapshot {
  const matches = chain.defiProtocols.filter((entry) => (
    entry.name.toLowerCase() === value.toLowerCase()
    || (entry.type ?? "mock-swap").toLowerCase() === value.toLowerCase()
    || entry.address.toLowerCase() === value.toLowerCase()
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `DeFi protocol is ambiguous: ${value}`
      : `DeFi protocol is not configured: ${value}`);
  }
  const protocol = matches[0]!;
  const helpers = protocol["help-contracts"];
  const helpContracts = helpers
    ? Object.fromEntries(Object.entries(helpers).map(([name, address]) => [
      name,
      normalizeAddress(address, chain.family),
    ]))
    : undefined;
  return {
    name: protocol.name,
    type: protocol.type ?? "mock-swap",
    outputBehavior: protocol.outputBehavior ?? "fixed",
    address: normalizeAddress(protocol.address, chain.family),
    ...(helpContracts ? { helpContracts } : {}),
  };
}

export function quoteDefi(request: DefiQuoteRequest) {
  return adapterFor(request.protocol.type).quote(request);
}

export function buildSwapCalls(request: DefiBuildRequest) {
  return adapterFor(request.protocol.type).buildSwapCalls(request);
}
