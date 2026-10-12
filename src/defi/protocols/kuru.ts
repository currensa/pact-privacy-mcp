import { Contract, Interface } from "ethers";
import { normalizeAddress } from "../../chain/address.js";
import type { CanonicalAddress } from "../../core/types.js";
import { FUNGIBLE_TOKEN_ABI } from "../../web3/abi.js";
import type { DefiProtocolSnapshot } from "../types.js";
import type { DefiProtocolAdapter } from "./types.js";

const MONAD_TESTNET_CHAIN_ID = 10143;
const ZERO = "0x0000000000000000000000000000000000000000" as CanonicalAddress;
const UINT96_MAX = (1n << 96n) - 1n;
const routerAbi = [
  "function verifiedMarket(address market) view returns (uint32 pricePrecision,uint96 sizePrecision,address baseAssetAddress,uint256 baseAssetDecimals,address quoteAssetAddress,uint256 quoteAssetDecimals,uint32 tickSize,uint96 minSize,uint96 maxSize,uint256 takerFeeBps,uint256 makerFeeBps)",
  "function anyToAnySwap(address[] marketAddresses,bool[] isBuy,bool[] nativeSend,address debitToken,address creditToken,uint256 amount,uint256 minAmountOut) payable returns (uint256 amountOut)",
];
const orderBookAbi = [
  "function getVaultParams() view returns (address kuruAmmVault,uint256 vaultBestBid,uint96 bidPartiallyFilledSize,uint256 vaultBestAsk,uint96 askPartiallyFilledSize,uint96 vaultBidOrderSize,uint96 vaultAskOrderSize,uint96 spread)",
  "function placeAndExecuteMarketBuy(uint96 quoteAmount,uint256 minAmountOut,bool isMargin,bool isFillOrKill) payable returns (uint256 amountOut)",
  "function placeAndExecuteMarketSell(uint96 size,uint256 minAmountOut,bool isMargin,bool isFillOrKill) payable returns (uint256 amountOut)",
];
const routerInterface = new Interface(routerAbi);
const erc20 = new Interface(FUNGIBLE_TOKEN_ABI);

type KuruHelpContracts = {
  market: CanonicalAddress;
  vault: CanonicalAddress;
  marginAccount: CanonicalAddress;
};

type KuruRoute = {
  chainId: number;
  router: CanonicalAddress;
  market: CanonicalAddress;
  vault: CanonicalAddress;
  baseToken: CanonicalAddress;
  quoteToken: CanonicalAddress;
  tokenIn: CanonicalAddress;
  tokenOut: CanonicalAddress;
  amountIn: string;
  amountOut: string;
  isBuy: boolean;
  blockNumber: string;
};

function helpContracts(protocol: DefiProtocolSnapshot): KuruHelpContracts {
  const helpers = protocol.helpContracts;
  if (!helpers) throw new Error("Kuru helper contracts are not configured");
  const required = ["market", "vault", "marginAccount"] as const;
  for (const name of required) {
    if (!helpers[name] || helpers[name] === ZERO) throw new Error(`Kuru helper contract is missing: ${name}`);
  }
  if (protocol.address === ZERO) throw new Error("Kuru Router is not configured");
  return helpers as Record<string, CanonicalAddress> & KuruHelpContracts;
}

function validateTokens(
  chainId: number,
  family: "evm" | "tron",
  inputToken: CanonicalAddress,
  outputToken: CanonicalAddress,
  amount: bigint,
): void {
  if (chainId !== MONAD_TESTNET_CHAIN_ID || family !== "evm") {
    throw new Error("Kuru is currently supported only on Monad Testnet");
  }
  if (inputToken === ZERO || outputToken === ZERO) throw new Error("Kuru currently supports ERC-20 tokens only");
  if (inputToken === outputToken) throw new Error("Kuru input and output tokens must differ");
  if (amount <= 0n) throw new Error("Kuru input amount must be positive");
}

function routePayload(value: unknown): KuruRoute {
  if (!value || typeof value !== "object") throw new Error("Kuru quote route is missing");
  const route = value as Partial<KuruRoute>;
  if (!Number.isSafeInteger(route.chainId) || typeof route.router !== "string"
    || typeof route.market !== "string" || typeof route.vault !== "string"
    || typeof route.baseToken !== "string" || typeof route.quoteToken !== "string"
    || typeof route.tokenIn !== "string" || typeof route.tokenOut !== "string"
    || typeof route.amountIn !== "string" || typeof route.amountOut !== "string"
    || typeof route.isBuy !== "boolean" || typeof route.blockNumber !== "string"
    || !/^[1-9][0-9]*$/.test(route.amountIn) || !/^[1-9][0-9]*$/.test(route.amountOut)
    || !/^[0-9]+$/.test(route.blockNumber)) {
    throw new Error("Invalid Kuru quote route");
  }
  return {
    chainId: route.chainId!,
    router: normalizeAddress(route.router, "evm"),
    market: normalizeAddress(route.market, "evm"),
    vault: normalizeAddress(route.vault, "evm"),
    baseToken: normalizeAddress(route.baseToken, "evm"),
    quoteToken: normalizeAddress(route.quoteToken, "evm"),
    tokenIn: normalizeAddress(route.tokenIn, "evm"),
    tokenOut: normalizeAddress(route.tokenOut, "evm"),
    amountIn: route.amountIn,
    amountOut: route.amountOut,
    isBuy: route.isBuy,
    blockNumber: route.blockNumber,
  };
}

function validateRoute(route: KuruRoute, request: {
  chainId: number;
  protocol: DefiProtocolSnapshot;
  inputToken: CanonicalAddress;
  outputToken: CanonicalAddress;
  amount: bigint;
  estimatedOutput?: bigint;
}): void {
  const helpers = helpContracts(request.protocol);
  if (route.chainId !== request.chainId) throw new Error("Kuru quote chain mismatch");
  if (route.router !== request.protocol.address) throw new Error("Kuru quote Router mismatch");
  if (route.market !== helpers.market) throw new Error("Kuru quote market mismatch");
  if (route.vault !== helpers.vault) throw new Error("Kuru quote vault mismatch");
  if (route.tokenIn !== request.inputToken) throw new Error("Kuru quote input token mismatch");
  if (route.tokenOut !== request.outputToken) throw new Error("Kuru quote output token mismatch");
  const directionMatches = route.isBuy
    ? route.tokenIn === route.quoteToken && route.tokenOut === route.baseToken
    : route.tokenIn === route.baseToken && route.tokenOut === route.quoteToken;
  if (!directionMatches) throw new Error("Kuru quote direction mismatch");
  if (BigInt(route.amountIn) !== request.amount) throw new Error("Kuru quote input amount mismatch");
  if (request.estimatedOutput !== undefined && BigInt(route.amountOut) !== request.estimatedOutput) {
    throw new Error("Kuru quote output amount mismatch");
  }
}

export const kuruAdapter: DefiProtocolAdapter = {
  type: "kuru",

  async quote(request) {
    if (request.runtime.family !== "evm") throw new Error("Kuru requires an EVM chain");
    validateTokens(request.chain.chainId, request.chain.family, request.inputToken, request.outputToken, request.amount);
    const helpers = helpContracts(request.protocol);
    const router = new Contract(request.protocol.address, routerAbi, request.runtime.provider);
    const market = new Contract(helpers.market, orderBookAbi, request.runtime.provider);
    const blockNumber = await request.runtime.provider.getBlockNumber();
    const [marketParams, vaultParams] = await Promise.all([
      router.getFunction("verifiedMarket").staticCall(helpers.market, { blockTag: blockNumber }),
      market.getFunction("getVaultParams").staticCall({ blockTag: blockNumber }),
    ]);
    const pricePrecision = BigInt(marketParams[0]);
    const sizePrecision = BigInt(marketParams[1]);
    const baseToken = normalizeAddress(String(marketParams[2]), "evm");
    const baseDecimals = BigInt(marketParams[3]);
    const quoteToken = normalizeAddress(String(marketParams[4]), "evm");
    const quoteDecimals = BigInt(marketParams[5]);
    if (pricePrecision <= 0n || sizePrecision <= 0n) throw new Error("Configured Kuru market is not registered");
    if (normalizeAddress(String(vaultParams[0]), "evm") !== helpers.vault) {
      throw new Error("Configured Kuru vault does not match the market");
    }

    const isBuy = request.inputToken === quoteToken && request.outputToken === baseToken;
    const isSell = request.inputToken === baseToken && request.outputToken === quoteToken;
    if (!isBuy && !isSell) throw new Error("The token pair is not supported by the configured Kuru market");
    const encodedAmount = isBuy
      ? request.amount * pricePrecision / (10n ** quoteDecimals)
      : request.amount * sizePrecision / (10n ** baseDecimals);
    if (encodedAmount <= 0n) throw new Error("Input amount is below the Kuru market precision");
    if (encodedAmount > UINT96_MAX) throw new Error("Input amount exceeds the Kuru market limit");

    const functionName = isBuy ? "placeAndExecuteMarketBuy" : "placeAndExecuteMarketSell";
    const amountOut = BigInt(await market.getFunction(functionName).staticCall(
      encodedAmount,
      0n,
      false,
      true,
      { from: ZERO, blockTag: blockNumber },
    ));
    const minimumOutput = amountOut * (10_000n - request.slippageBips) / 10_000n;
    if (amountOut <= 0n || minimumOutput <= 0n) throw new Error("Kuru returned an empty quote");
    const route: KuruRoute = {
      chainId: request.chain.chainId,
      router: request.protocol.address,
      market: helpers.market,
      vault: helpers.vault,
      baseToken,
      quoteToken,
      tokenIn: request.inputToken,
      tokenOut: request.outputToken,
      amountIn: request.amount.toString(),
      amountOut: amountOut.toString(),
      isBuy,
      blockNumber: blockNumber.toString(),
    };
    return {
      amountIn: request.amount,
      estimatedOutput: amountOut,
      minimumOutput,
      routeLabel: "Direct Kuru market",
      payload: route,
    };
  },

  buildSwapCalls(request) {
    validateTokens(request.chainId, request.family, request.inputToken, request.outputToken, request.amount);
    const route = routePayload(request.quote.payload);
    validateRoute(route, {
      chainId: request.chainId,
      protocol: request.protocol,
      inputToken: request.inputToken,
      outputToken: request.outputToken,
      amount: request.amount,
      estimatedOutput: request.quote.estimatedOutput,
    });
    const minimumOutput = request.requiredOutput && request.requiredOutput > request.quote.minimumOutput
      ? request.requiredOutput
      : request.quote.minimumOutput;
    if (minimumOutput <= 0n || minimumOutput > request.quote.estimatedOutput) {
      throw new Error("Invalid Kuru minimum output");
    }
    return {
      outputLocation: "pure-router",
      calls: [
        {
          target: request.inputToken,
          value: 0n,
          data: erc20.encodeFunctionData("approve", [request.protocol.address, request.amount]) as `0x${string}`,
        },
        {
          target: request.protocol.address,
          value: 0n,
          data: routerInterface.encodeFunctionData("anyToAnySwap", [
            [route.market],
            [route.isBuy],
            [false],
            request.inputToken,
            request.outputToken,
            request.amount,
            minimumOutput,
          ]) as `0x${string}`,
        },
        {
          target: request.inputToken,
          value: 0n,
          data: erc20.encodeFunctionData("approve", [request.protocol.address, 0n]) as `0x${string}`,
        },
      ],
    };
  },
};
