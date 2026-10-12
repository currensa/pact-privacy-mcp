import { Contract, Interface } from "ethers";
import { normalizeAddress } from "../../chain/address.js";
import type { CanonicalAddress } from "../../core/types.js";
import { FUNGIBLE_TOKEN_ABI } from "../../web3/abi.js";
import type { DefiProtocolSnapshot } from "../types.js";
import type { DefiProtocolAdapter } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000" as CanonicalAddress;
const FEE_TIERS = [100, 500, 3000, 10000] as const;
const factoryAbi = ["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"];
const quoterV2Abi = ["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"];
const router = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);
const erc20 = new Interface(FUNGIBLE_TOKEN_ABI);

type UniswapV3HelpContracts = {
  factory: CanonicalAddress;
  quoterV2: CanonicalAddress;
  swapRouter02: CanonicalAddress;
  weth9: CanonicalAddress;
};

type UniswapV3Route = {
  chainId: number;
  tokenIn: CanonicalAddress;
  tokenOut: CanonicalAddress;
  amountIn: string;
  amountOut: string;
  fee: number;
  pool: CanonicalAddress;
};

function helpContracts(protocol: DefiProtocolSnapshot): UniswapV3HelpContracts {
  const helpers = protocol.helpContracts;
  if (!helpers) throw new Error("Uniswap V3 helper contracts are not configured");
  const required = ["factory", "quoterV2", "swapRouter02", "weth9"] as const;
  for (const name of required) {
    if (!helpers[name] || helpers[name] === ZERO) throw new Error(`Uniswap V3 helper contract is missing: ${name}`);
  }
  if (helpers.swapRouter02 !== protocol.address) {
    throw new Error("Uniswap V3 primary address does not match SwapRouter02");
  }
  return helpers as Record<string, CanonicalAddress> & UniswapV3HelpContracts;
}

function validateTokens(family: "evm" | "tron", inputToken: CanonicalAddress, outputToken: CanonicalAddress, amount: bigint): void {
  if (family !== "evm" || inputToken === ZERO || outputToken === ZERO) {
    throw new Error("Uniswap V3 supports ERC-20 tokens on EVM chains only; wrap ETH into WETH first");
  }
  if (inputToken === outputToken) throw new Error("Uniswap V3 input and output tokens must differ");
  if (amount <= 0n) throw new Error("Uniswap V3 input amount must be positive");
}

function routePayload(value: unknown): UniswapV3Route {
  if (!value || typeof value !== "object") throw new Error("Uniswap V3 quote route is missing");
  const route = value as Partial<UniswapV3Route>;
  if (!Number.isSafeInteger(route.chainId) || typeof route.tokenIn !== "string"
    || typeof route.tokenOut !== "string" || typeof route.amountIn !== "string"
    || typeof route.amountOut !== "string" || !Number.isInteger(route.fee)
    || typeof route.pool !== "string" || !FEE_TIERS.includes(route.fee as typeof FEE_TIERS[number])
    || !/^[1-9][0-9]*$/.test(route.amountIn) || !/^[1-9][0-9]*$/.test(route.amountOut)) {
    throw new Error("Invalid Uniswap V3 quote route");
  }
  const normalized = {
    chainId: route.chainId!,
    tokenIn: normalizeAddress(route.tokenIn, "evm"),
    tokenOut: normalizeAddress(route.tokenOut, "evm"),
    amountIn: route.amountIn,
    amountOut: route.amountOut,
    fee: route.fee!,
    pool: normalizeAddress(route.pool, "evm"),
  };
  if (normalized.pool === ZERO) throw new Error("Invalid Uniswap V3 quote route");
  return normalized;
}

function validateRoute(route: UniswapV3Route, request: {
  chainId: number;
  inputToken: CanonicalAddress;
  outputToken: CanonicalAddress;
  amount: bigint;
  estimatedOutput?: bigint;
}): void {
  if (route.chainId !== request.chainId) throw new Error("Uniswap V3 quote chain mismatch");
  if (route.tokenIn !== request.inputToken) throw new Error("Uniswap V3 quote input token mismatch");
  if (route.tokenOut !== request.outputToken) throw new Error("Uniswap V3 quote output token mismatch");
  if (BigInt(route.amountIn) !== request.amount) throw new Error("Uniswap V3 quote input amount mismatch");
  if (request.estimatedOutput !== undefined && BigInt(route.amountOut) !== request.estimatedOutput) {
    throw new Error("Uniswap V3 quote output amount mismatch");
  }
}

export const uniswapV3Adapter: DefiProtocolAdapter = {
  type: "uniswap-v3",

  async quote(request) {
    if (request.runtime.family !== "evm") throw new Error("Uniswap V3 requires an EVM chain");
    validateTokens(request.chain.family, request.inputToken, request.outputToken, request.amount);
    const helpers = helpContracts(request.protocol);
    const factory = new Contract(helpers.factory, factoryAbi, request.runtime.provider);
    const quoter = new Contract(helpers.quoterV2, quoterV2Abi, request.runtime.provider);
    const candidates = await Promise.all(FEE_TIERS.map(async (fee) => {
      try {
        const value = await factory.getFunction("getPool").staticCall(request.inputToken, request.outputToken, fee);
        const pool = normalizeAddress(String(value), "evm");
        if (pool === ZERO) return undefined;
        const result = await quoter.getFunction("quoteExactInputSingle").staticCall({
          tokenIn: request.inputToken,
          tokenOut: request.outputToken,
          amountIn: request.amount,
          fee,
          sqrtPriceLimitX96: 0n,
        }) as [bigint, bigint, bigint, bigint];
        const amountOut = BigInt(result[0]);
        return amountOut > 0n ? { fee, pool, amountOut } : undefined;
      } catch {
        return undefined;
      }
    }));
    const best = candidates.filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .sort((left, right) => left.amountOut === right.amountOut ? 0 : left.amountOut > right.amountOut ? -1 : 1)[0];
    if (!best) throw new Error("No usable direct Uniswap V3 pool is available for this pair");
    const minimumOutput = best.amountOut * (10_000n - request.slippageBips) / 10_000n;
    if (minimumOutput <= 0n) throw new Error("Uniswap V3 returned an empty quote");
    const route: UniswapV3Route = {
      chainId: request.chain.chainId,
      tokenIn: request.inputToken,
      tokenOut: request.outputToken,
      amountIn: request.amount.toString(),
      amountOut: best.amountOut.toString(),
      fee: best.fee,
      pool: best.pool,
    };
    return {
      amountIn: request.amount,
      estimatedOutput: best.amountOut,
      minimumOutput,
      routeLabel: `Direct pool · ${best.fee / 10_000}% fee`,
      payload: route,
    };
  },

  buildSwapCalls(request) {
    validateTokens(request.family, request.inputToken, request.outputToken, request.amount);
    const helpers = helpContracts(request.protocol);
    const route = routePayload(request.quote.payload);
    validateRoute(route, {
      chainId: request.chainId,
      inputToken: request.inputToken,
      outputToken: request.outputToken,
      amount: request.amount,
      estimatedOutput: request.quote.estimatedOutput,
    });
    const minimumOutput = request.requiredOutput && request.requiredOutput > request.quote.minimumOutput
      ? request.requiredOutput
      : request.quote.minimumOutput;
    if (minimumOutput <= 0n || minimumOutput > request.quote.estimatedOutput) {
      throw new Error("Invalid Uniswap V3 minimum output");
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    const swap = router.encodeFunctionData("exactInputSingle", [[
      request.inputToken,
      request.outputToken,
      route.fee,
      request.destination,
      request.amount,
      minimumOutput,
      0n,
    ]]) as `0x${string}`;
    return {
      outputLocation: "recipient",
      calls: [
        {
          target: request.inputToken,
          value: 0n,
          data: erc20.encodeFunctionData("approve", [helpers.swapRouter02, request.amount]) as `0x${string}`,
        },
        {
          target: helpers.swapRouter02,
          value: 0n,
          data: router.encodeFunctionData("multicall", [deadline, [swap]]) as `0x${string}`,
        },
        {
          target: request.inputToken,
          value: 0n,
          data: erc20.encodeFunctionData("approve", [helpers.swapRouter02, 0n]) as `0x${string}`,
        },
      ],
    };
  },
};
