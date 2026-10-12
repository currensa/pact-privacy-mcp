import {
  Address,
  parseRouteAPIResponse,
  PoolVersion,
  TradePlanner,
  type RouteData,
} from "@sun-protocol/universal-router-sdk";
import { Interface } from "ethers";
import { normalizeAddress, tronBase58FromCanonical } from "../../chain/address.js";
import type { ChainDetails, CanonicalAddress } from "../../core/types.js";
import { FUNGIBLE_TOKEN_ABI } from "../../web3/abi.js";
import type { DefiProtocolSnapshot } from "../types.js";
import type { DefiProtocolAdapter } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000" as CanonicalAddress;
const MAX_UINT160 = (1n << 160n) - 1n;
const QUOTE_SELECTOR = "quoteExactInputSingle(((address,address,address,uint24,bytes32),bool,uint128,bytes))";
const POOL_TUPLE = "((address,address,address,uint24,bytes32),bool,uint128,bytes)";
const erc20 = new Interface(FUNGIBLE_TOKEN_ABI);
const universalRouter = new Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const permit2 = new Interface(["function approve(address token,address spender,uint160 amount,uint48 expiration)"]);

type Pool = {
  currency0: CanonicalAddress;
  currency1: CanonicalAddress;
  hooks: CanonicalAddress;
  fee: number;
  parameters: `0x${string}`;
};

type SunSwapHelpContracts = {
  universalRouter: CanonicalAddress;
  permit2: CanonicalAddress;
  poolManager: CanonicalAddress;
  quoter: CanonicalAddress;
};

const pools = new Map<string, { expiresAt: number; value: Promise<Pool[]> }>();

function helpContracts(protocol: DefiProtocolSnapshot): SunSwapHelpContracts {
  const helpers = protocol.helpContracts;
  if (!helpers) throw new Error("SunSwap V4 helper contracts are not configured");
  const required = ["universalRouter", "permit2", "poolManager", "quoter"] as const;
  for (const name of required) {
    if (!helpers[name]) throw new Error(`SunSwap V4 helper contract is missing: ${name}`);
  }
  return helpers as Record<string, CanonicalAddress> & SunSwapHelpContracts;
}

async function loadPools(chain: ChainDetails, protocol: DefiProtocolSnapshot): Promise<Pool[]> {
  const helpers = helpContracts(protocol);
  const rpc = chain.rpcUrls?.[0];
  if (!rpc) throw new Error("TRON RPC URL is unavailable");
  const key = `${chain.chainId}:${helpers.poolManager}`;
  const cached = pools.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = (async () => {
    const result: Pool[] = [];
    let fingerprint: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`/v1/contracts/${tronBase58FromCanonical(helpers.poolManager)}/events`, rpc);
      url.searchParams.set("event_name", "Initialize");
      url.searchParams.set("only_confirmed", "true");
      url.searchParams.set("limit", "200");
      if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`TRON PoolManager events returned HTTP ${response.status}`);
      const body = await response.json() as {
        data?: Array<{ result?: Record<string, string> }>;
        meta?: { fingerprint?: string };
      };
      for (const event of body.data ?? []) {
        const row = event.result;
        if (!row?.currency0 || !row.currency1 || !row.hooks || !row.fee || !row.parameters) continue;
        const hooks = normalizeAddress(row.hooks, "tron");
        if (hooks !== ZERO) continue;
        result.push({
          currency0: normalizeAddress(row.currency0, "tron"),
          currency1: normalizeAddress(row.currency1, "tron"),
          hooks,
          fee: Number(row.fee),
          parameters: (row.parameters.startsWith("0x") ? row.parameters : `0x${row.parameters}`) as `0x${string}`,
        });
      }
      const next = body.meta?.fingerprint;
      if (!next || next === fingerprint) break;
      fingerprint = next;
    }
    return result;
  })();
  pools.set(key, { expiresAt: Date.now() + 5 * 60_000, value });
  value.catch(() => {
    if (pools.get(key)?.value === value) pools.delete(key);
  });
  return value;
}

export const sunSwapV4Adapter: DefiProtocolAdapter = {
  type: "sunswap-v4",

  async quote(request) {
    if (request.runtime.family !== "tron") throw new Error("SunSwap V4 requires TRON");
    const runtime = request.runtime;
    const helpers = helpContracts(request.protocol);
    const candidates = (await loadPools(request.chain, request.protocol)).filter((pool) => (
      pool.currency0 === request.inputToken && pool.currency1 === request.outputToken
    ) || (pool.currency0 === request.outputToken && pool.currency1 === request.inputToken));
    const quoter = tronBase58FromCanonical(helpers.quoter);
    const quotes = await Promise.all(candidates.map(async (pool) => {
      try {
        const result = await runtime.tronWeb.transactionBuilder.triggerConstantContract(
          quoter,
          QUOTE_SELECTOR,
          {},
          [{
            type: POOL_TUPLE,
            value: [[pool.currency0, pool.currency1, pool.hooks, pool.fee, pool.parameters], request.inputToken === pool.currency0, request.amount.toString(), "0x"],
          }],
          quoter,
        ) as { constant_result?: string[] };
        const encoded = result.constant_result?.[0];
        if (!encoded) return undefined;
        const clean = encoded.replace(/^0x/, "");
        if (!/^[0-9a-fA-F]{64,}$/.test(clean)) return undefined;
        const output = BigInt(`0x${clean.slice(0, 64)}`);
        return output > 0n ? { pool, output } : undefined;
      } catch {
        return undefined;
      }
    }));
    const best = quotes.filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .sort((left, right) => left.output === right.output ? 0 : left.output > right.output ? -1 : 1)[0];
    if (!best) throw new Error("No usable direct SunSwap V4 pool is available for this pair");
    const token = (address: CanonicalAddress) => address === ZERO
      ? "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
      : tronBase58FromCanonical(address);
    const route: RouteData = {
      amountIn: request.amount.toString(),
      amountInRaw: request.amount.toString(),
      amountOut: best.output.toString(),
      amountOutRaw: best.output.toString(),
      amountOutMinimum: best.output.toString(),
      amountOutMinimumRaw: best.output.toString(),
      inUsd: "0",
      outUsd: "0",
      impact: "0",
      fee: String(best.pool.fee),
      containsUnverifiedHook: false,
      tokens: [token(request.inputToken), token(request.outputToken)],
      symbols: ["Input", "Output"],
      poolFees: [String(best.pool.fee)],
      poolVersions: ["v4"],
      poolKeys: [{
        token0: token(best.pool.currency0),
        token1: token(best.pool.currency1),
        hooks: token(best.pool.hooks),
        fee: best.pool.fee,
        parameters: best.pool.parameters,
      }],
      stepAmountsOut: [best.output.toString()],
    };
    return {
      amountIn: request.amount,
      estimatedOutput: best.output,
      minimumOutput: best.output * (10_000n - request.slippageBips) / 10_000n,
      routeLabel: "SunSwap V4",
      payload: route,
    };
  },

  buildSwapCalls(request) {
    if (request.family !== "tron" || !request.quote.payload) throw new Error("SunSwap V4 route is unavailable");
    const helpers = helpContracts(request.protocol);
    if (request.amount > MAX_UINT160) throw new Error("SunSwap input exceeds Permit2 limits");
    const routeData = request.quote.payload as RouteData;
    if (routeData.containsUnverifiedHook
      || routeData.poolVersions.some((version) => version.toLowerCase() !== PoolVersion.V4)) {
      throw new Error("SunSwap route is not an approved V4 route");
    }
    const route = parseRouteAPIResponse(routeData, true, { slippageBips: request.slippageBips });
    route.minimumAmountOut = request.requiredOutput && request.requiredOutput > request.quote.minimumOutput
      ? request.requiredOutput
      : request.quote.minimumOutput;
    route.recipient = new Address(request.destination);
    const planner = new TradePlanner([route]);
    planner.encode();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    const calls = [];
    if (request.inputToken !== ZERO) {
      calls.push(
        {
          target: request.inputToken,
          value: 0n,
          data: erc20.encodeFunctionData("approve", [helpers.permit2, request.amount]) as `0x${string}`,
        },
        {
          target: helpers.permit2,
          value: 0n,
          data: permit2.encodeFunctionData("approve", [
            request.inputToken, helpers.universalRouter, request.amount, deadline,
          ]) as `0x${string}`,
        },
      );
    }
    calls.push({
      target: helpers.universalRouter,
      value: request.inputToken === ZERO ? request.amount : 0n,
      data: universalRouter.encodeFunctionData("execute", [planner.commands, planner.inputs, deadline]) as `0x${string}`,
    });
    if (request.inputToken !== ZERO) {
      calls.push(
        {
          target: helpers.permit2,
          value: 0n,
          data: permit2.encodeFunctionData("approve", [request.inputToken, helpers.universalRouter, 0n, 0]) as `0x${string}`,
        },
        {
          target: request.inputToken,
          value: 0n,
          data: erc20.encodeFunctionData("approve", [helpers.permit2, 0n]) as `0x${string}`,
        },
      );
    }
    return { calls, outputLocation: "recipient" };
  },
};
