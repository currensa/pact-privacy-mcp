import { formatUnits } from "ethers";
import type { PactPrivacyClient } from "../runtime/client.js";
import { resolveDefiMarketQuote, type DefiMarketQuoteInput } from "./prepare.js";

export class DefiQuoteService {
  constructor(private readonly client: PactPrivacyClient) {}

  async quote(input: DefiMarketQuoteInput) {
    const resolved = await resolveDefiMarketQuote(this.client, input);
    const quotedAt = new Date().toISOString();
    return {
      chainId: input.chainId,
      protocol: {
        name: resolved.protocol.name,
        type: resolved.protocol.type,
        outputBehavior: resolved.protocol.outputBehavior,
      },
      input: {
        token: resolved.inputAsset.token,
        symbol: resolved.inputAsset.symbol,
        decimals: resolved.inputAsset.decimals,
        amount: formatUnits(resolved.swapAmount, resolved.inputAsset.decimals),
        rawAmount: resolved.swapAmount.toString(),
      },
      output: {
        token: resolved.outputAsset.token,
        symbol: resolved.outputAsset.symbol,
        decimals: resolved.outputAsset.decimals,
        estimatedAmount: formatUnits(resolved.quote.estimatedOutput, resolved.outputAsset.decimals),
        estimatedRawAmount: resolved.quote.estimatedOutput.toString(),
        recommendedMinimumAmount: formatUnits(resolved.quote.minimumOutput, resolved.outputAsset.decimals),
        recommendedMinimumRawAmount: resolved.quote.minimumOutput.toString(),
      },
      slippageBips: resolved.slippageBips.toString(),
      route: resolved.quote.routeLabel,
      quotedAt,
      advisory: true,
      executionRefreshesQuote: true,
    };
  }
}
