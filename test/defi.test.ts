import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Interface, getAddress, keccak256 } from "ethers";
import { buildSwapCalls } from "../src/defi/adapter.js";
import { buildDefiPlan } from "../src/defi/prepare.js";
import type { DefiProtocolSnapshot, DefiQuote } from "../src/defi/types.js";
import { computeDefiCommitment } from "../src/defi/commitment.js";
import { RelayerClient } from "../src/relayer/client.js";
import type { PactPrivacyClient } from "../src/runtime/client.js";

test("rejects refund support for Organization DeFi re-deposits before reading chain state", async () => {
  await assert.rejects(
    () => buildDefiPlan({} as PactPrivacyClient, { refund: true } as never),
    /Organization DeFi re-deposits are non-refundable/,
  );
});

test("computes the DeFi call commitment used as the withdrawal recipient", () => {
  const call = {
    target: "0x1111111111111111111111111111111111111111" as const,
    value: 7n,
    data: "0x1234" as const,
  };
  const coder = AbiCoder.defaultAbiCoder();
  const callHash = keccak256(coder.encode(["address", "uint256", "bytes"], [call.target, call.value, call.data]));
  const callsHash = keccak256(callHash);
  const expected = getAddress(`0x${keccak256(coder.encode(["uint256", "bytes32"], [3n, callsHash])).slice(-40)}`).toLowerCase();
  assert.equal(computeDefiCommitment(3n, [call]), expected);
});

test("requests a gross-budget relayed DeFi quote", async () => {
  let body: Record<string, unknown> | undefined;
  const client = new RelayerClient("http://localhost:9000", async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "quote-id", operation: "defi", chainId: 1, gravArc: "0x1", relayer: "0x2", token: "0x0",
      amount: "90", tier: 8, networkFee: "9", serviceFee: "1", fee: "10", serviceFeeBps: 10,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await client.quoteDefi({
    chainId: 1, token: "0x0", amount: "100", tier: 8, privateRedeposit: true, redepositTier: 16,
  });
  assert.deepEqual(body, {
    chainId: 1, token: "0x0", amount: "100", tier: 8, privateRedeposit: true, redepositTier: 16,
  });
});

const inputToken = "0x1111111111111111111111111111111111111111" as const;
const outputToken = "0x2222222222222222222222222222222222222222" as const;
const factory = "0x3333333333333333333333333333333333333333" as const;
const quoterV2 = "0x4444444444444444444444444444444444444444" as const;
const swapRouter02 = "0x5555555555555555555555555555555555555555" as const;
const weth9 = "0x6666666666666666666666666666666666666666" as const;
const pool = "0x7777777777777777777777777777777777777777" as const;
const destination = "0x8888888888888888888888888888888888888888" as const;
const pureRouter = "0x9999999999999999999999999999999999999999" as const;

const kuruRouter = "0x7efbe105ca7415de98f96622173458ac1c054630" as const;
const kuruMarket = "0xdc8d4197aceb1ca86446d6e77889f1b3397adfa9" as const;
const kuruVault = "0x89435e121086474f3a2f4ba479509390cd98f545" as const;
const kuruMarginAccount = "0xd029c2d98ff85d8f64799017fe00a59b1159ce02" as const;
const kuruBaseToken = "0x44e9820a45886275b48ebb4c091d032d57e6a402" as const;
const kuruQuoteToken = "0xbc18ffe052aaa538f028c90661f7b38a68a77257" as const;

const kuruProtocol: DefiProtocolSnapshot = {
  name: "Kuru",
  type: "kuru",
  outputBehavior: "variable",
  address: kuruRouter,
  helpContracts: { market: kuruMarket, vault: kuruVault, marginAccount: kuruMarginAccount },
};

function kuruQuote(overrides: Record<string, unknown> = {}): DefiQuote {
  return {
    amountIn: 10_000_000_000_000_000_000n,
    estimatedOutput: 9_871_287_128_712_871_287n,
    minimumOutput: 9_821_930_693_069_306_930n,
    routeLabel: "Direct Kuru market",
    payload: {
      chainId: 10143,
      router: kuruRouter,
      market: kuruMarket,
      vault: kuruVault,
      baseToken: kuruBaseToken,
      quoteToken: kuruQuoteToken,
      tokenIn: kuruBaseToken,
      tokenOut: kuruQuoteToken,
      amountIn: "10000000000000000000",
      amountOut: "9871287128712871287",
      isBuy: false,
      blockNumber: "62968341",
      ...overrides,
    },
  };
}

const uniswapProtocol: DefiProtocolSnapshot = {
  name: "Uniswap V3",
  type: "uniswap-v3",
  outputBehavior: "variable",
  address: swapRouter02,
  helpContracts: { factory, quoterV2, swapRouter02, weth9 },
};

function uniswapQuote(overrides: Record<string, unknown> = {}): DefiQuote {
  return {
    amountIn: 1_000_000n,
    estimatedOutput: 500_000n,
    minimumOutput: 495_000n,
    routeLabel: "Direct pool · 0.05% fee",
    payload: {
      chainId: 11155111,
      tokenIn: inputToken,
      tokenOut: outputToken,
      amountIn: "1000000",
      amountOut: "500000",
      fee: 500,
      pool,
      ...overrides,
    },
  };
}

test("builds bound Uniswap V3 exact-input calls with allowance cleanup", () => {
  const calls = buildSwapCalls({
    chainId: 11155111,
    family: "evm",
    protocol: uniswapProtocol,
    inputToken,
    outputToken,
    amount: 1_000_000n,
    quote: uniswapQuote(),
    pureRouter,
    destination,
    slippageBips: 50n,
    requiredOutput: 497_000n,
  });
  assert.equal(calls.outputLocation, "recipient");
  assert.equal(calls.calls.length, 3);
  assert.deepEqual(calls.calls.map((call) => call.target), [inputToken, swapRouter02, inputToken]);

  const token = new Interface(["function approve(address spender,uint256 amount)"]);
  assert.deepEqual([...token.decodeFunctionData("approve", calls.calls[0]!.data)], [swapRouter02, 1_000_000n]);
  assert.deepEqual([...token.decodeFunctionData("approve", calls.calls[2]!.data)], [swapRouter02, 0n]);

  const router = new Interface([
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
    "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
  ]);
  const decodedMulticall = router.decodeFunctionData("multicall", calls.calls[1]!.data);
  const decodedSwap = router.decodeFunctionData("exactInputSingle", decodedMulticall[1][0]);
  assert.equal(decodedSwap[0].tokenIn.toLowerCase(), inputToken);
  assert.equal(decodedSwap[0].tokenOut.toLowerCase(), outputToken);
  assert.equal(decodedSwap[0].fee, 500n);
  assert.equal(decodedSwap[0].recipient.toLowerCase(), destination);
  assert.equal(decodedSwap[0].amountIn, 1_000_000n);
  assert.equal(decodedSwap[0].amountOutMinimum, 497_000n);
  assert.equal(decodedSwap[0].sqrtPriceLimitX96, 0n);
});

test("rejects tampered and native Uniswap V3 routes", () => {
  const common = {
    chainId: 11155111,
    family: "evm" as const,
    protocol: uniswapProtocol,
    inputToken,
    outputToken,
    amount: 1_000_000n,
    pureRouter,
    destination,
    slippageBips: 50n,
  };
  assert.throws(() => buildSwapCalls({ ...common, quote: uniswapQuote({ chainId: 1 }) }), /chain mismatch/);
  assert.throws(() => buildSwapCalls({ ...common, quote: uniswapQuote({ fee: 250 }) }), /Invalid Uniswap V3 quote route/);
  assert.throws(() => buildSwapCalls({
    ...common,
    inputToken: "0x0000000000000000000000000000000000000000",
    quote: uniswapQuote({ tokenIn: "0x0000000000000000000000000000000000000000" }),
  }), /ERC-20 tokens/);
});

test("builds the frontend-compatible Kuru fixture as one exact-input market call", () => {
  const result = buildSwapCalls({
    chainId: 10143,
    family: "evm",
    protocol: kuruProtocol,
    inputToken: kuruBaseToken,
    outputToken: kuruQuoteToken,
    amount: 10_000_000_000_000_000_000n,
    quote: kuruQuote(),
    pureRouter,
    destination,
    slippageBips: 50n,
    requiredOutput: 9_850_000_000_000_000_000n,
  });
  assert.equal(result.outputLocation, "pure-router");
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.calls.map((call) => call.target), [kuruBaseToken, kuruRouter, kuruBaseToken]);
  assert.ok(result.calls.every((call) => call.value === 0n));

  const token = new Interface(["function approve(address spender,uint256 amount)"]);
  const approval = token.decodeFunctionData("approve", result.calls[0]!.data);
  assert.equal(String(approval[0]).toLowerCase(), kuruRouter);
  assert.equal(approval[1], 10_000_000_000_000_000_000n);
  const clearedApproval = token.decodeFunctionData("approve", result.calls[2]!.data);
  assert.equal(String(clearedApproval[0]).toLowerCase(), kuruRouter);
  assert.equal(clearedApproval[1], 0n);

  const router = new Interface([
    "function anyToAnySwap(address[] marketAddresses,bool[] isBuy,bool[] nativeSend,address debitToken,address creditToken,uint256 amount,uint256 minAmountOut) payable returns (uint256 amountOut)",
  ]);
  const decoded = router.decodeFunctionData("anyToAnySwap", result.calls[1]!.data);
  assert.deepEqual([...decoded[0]].map((value) => String(value).toLowerCase()), [kuruMarket]);
  assert.deepEqual([...decoded[1]], [false]);
  assert.deepEqual([...decoded[2]], [false]);
  assert.equal(String(decoded[3]).toLowerCase(), kuruBaseToken);
  assert.equal(String(decoded[4]).toLowerCase(), kuruQuoteToken);
  assert.equal(decoded[5], 10_000_000_000_000_000_000n);
  assert.equal(decoded[6], 9_850_000_000_000_000_000n);
});

test("rejects tampered, mismatched, and native Kuru routes", () => {
  const common = {
    chainId: 10143,
    family: "evm" as const,
    protocol: kuruProtocol,
    inputToken: kuruBaseToken,
    outputToken: kuruQuoteToken,
    amount: 10_000_000_000_000_000_000n,
    pureRouter,
    destination,
    slippageBips: 50n,
  };
  assert.throws(() => buildSwapCalls({ ...common, quote: kuruQuote({ chainId: 1 }) }), /chain mismatch/);
  assert.throws(() => buildSwapCalls({ ...common, quote: kuruQuote({ market: pool }) }), /market mismatch/);
  assert.throws(() => buildSwapCalls({ ...common, quote: kuruQuote({ isBuy: true }) }), /direction mismatch/);
  assert.throws(() => buildSwapCalls({
    ...common,
    inputToken: "0x0000000000000000000000000000000000000000",
    quote: kuruQuote({ tokenIn: "0x0000000000000000000000000000000000000000" }),
  }), /ERC-20 tokens/);
});
