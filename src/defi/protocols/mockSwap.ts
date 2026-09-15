import { Interface } from "ethers";
import type { CanonicalAddress } from "../../core/types.js";
import { FUNGIBLE_TOKEN_ABI } from "../../web3/abi.js";
import type { DefiProtocolAdapter } from "./types.js";

const ZERO = "0x0000000000000000000000000000000000000000" as CanonicalAddress;
const erc20 = new Interface(FUNGIBLE_TOKEN_ABI);
const mockSwap = new Interface(["function swap(address tokenIn,uint256 amountIn,address tokenOut,address recipient)"]);

function validate(family: "evm" | "tron", inputToken: CanonicalAddress, outputToken: CanonicalAddress): void {
  if (family !== "evm" || inputToken === ZERO || outputToken === ZERO) {
    throw new Error("MockSwap supports ERC-20 tokens on EVM chains only");
  }
}

function scaled(amount: bigint, inputDecimals: number, outputDecimals: number): bigint {
  return outputDecimals >= inputDecimals
    ? amount * 10n ** BigInt(outputDecimals - inputDecimals)
    : amount / 10n ** BigInt(inputDecimals - outputDecimals);
}

export const mockSwapAdapter: DefiProtocolAdapter = {
  type: "mock-swap",

  async quote(request) {
    validate(request.chain.family, request.inputToken, request.outputToken);
    const estimated = scaled(request.amount, request.inputDecimals, request.outputDecimals);
    return {
      amountIn: request.amount,
      estimatedOutput: estimated,
      minimumOutput: estimated,
      routeLabel: request.protocol.name,
    };
  },

  buildSwapCalls(request) {
    validate(request.family, request.inputToken, request.outputToken);
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
          data: mockSwap.encodeFunctionData("swap", [
            request.inputToken, request.amount, request.outputToken, request.pureRouter,
          ]) as `0x${string}`,
        },
      ],
    };
  },
};
