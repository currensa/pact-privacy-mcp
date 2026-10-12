import { formatUnits } from "ethers";
import { normalizeAddress } from "../chain/address.js";
import { defiAsset, resolveDefiMarketQuote } from "../defi/prepare.js";
import type { CircuitTier } from "../proof/artifact-cache.js";
import { RelayerClient } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";

const TIERS = new Set([8, 16, 32, 64, 128]);

export type RelayedDefiQuoteInput = {
  chainId: number;
  tier: CircuitTier;
  redepositTier?: CircuitTier;
  inputToken: string;
  outputToken: string;
  protocol: string;
  withdrawalAmount: string;
  relayerUrl: string;
  maximumFee?: string;
  slippageBips?: number;
};

export class RelayedDefiQuoteService {
  constructor(private readonly client: PactPrivacyClient) {}

  async quote(input: RelayedDefiQuoteInput) {
    if (!TIERS.has(input.tier)) throw new Error(`Unsupported withdrawal tier: ${input.tier}`);
    const { config, runtime } = await this.client.chain(input.chainId);
    if (!config.pactPrivacyDefiRouter) throw new Error("DeFi router is not configured");
    const web3 = new Web3Service(config, runtime);
    const inputAsset = await defiAsset(web3, input.inputToken);
    const inputToken = inputAsset.token;
    const inputDecimals = inputAsset.decimals;
    const withdrawalBudget = web3.parseTokenAmount(input.withdrawalAmount, inputDecimals);
    if (withdrawalBudget <= 0n) throw new Error("Withdrawal amount must be positive");
    const maximumFee = input.maximumFee === undefined ? undefined : web3.parseTokenAmount(input.maximumFee, inputDecimals);
    const relayerClient = new RelayerClient(input.relayerUrl);
    const relayQuote = await relayerClient.quoteDefi({
      chainId: input.chainId, token: inputToken, amount: withdrawalBudget.toString(), tier: input.tier,
      ...(input.redepositTier === undefined ? {} : { privateRedeposit: true, redepositTier: input.redepositTier }),
    });
    const expiry = Date.parse(relayQuote.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Relayer returned an expired quote");
    const fee = BigInt(relayQuote.fee);
    const swapAmount = BigInt(relayQuote.amount);
    const totalWithdrawal = swapAmount + fee;
    if (relayQuote.operation !== undefined && relayQuote.operation !== "defi") throw new Error("Relayer quote is not for DeFi");
    if (relayQuote.chainId !== input.chainId || normalizeAddress(relayQuote.token, config.family) !== inputToken
      || relayQuote.tier !== input.tier
      || Boolean(relayQuote.privateRedeposit) !== (input.redepositTier !== undefined)
      || (relayQuote.redepositTier ?? null) !== (input.redepositTier ?? null)
      || normalizeAddress(relayQuote.defiRouter ?? relayQuote.gravArc, config.family) !== normalizeAddress(config.pactPrivacyDefiRouter, config.family)) {
      throw new Error("Relayer quote does not match the requested DeFi operation");
    }
    if (swapAmount <= 0n || fee <= 0n || totalWithdrawal > withdrawalBudget) throw new Error("Relayer returned an invalid DeFi fee quote");
    if (maximumFee !== undefined && fee > maximumFee) throw new Error("Relayer DeFi fee exceeds the accepted maximum");
    const market = await resolveDefiMarketQuote(this.client, {
      chainId: input.chainId, inputToken, outputToken: input.outputToken, protocol: input.protocol,
      amount: formatUnits(swapAmount, inputDecimals),
      ...(input.slippageBips === undefined ? {} : { slippageBips: input.slippageBips }),
    });
    return {
      chainId: input.chainId,
      tier: input.tier,
      privateRedeposit: input.redepositTier !== undefined,
      redepositTier: input.redepositTier ?? null,
      protocol: { name: market.protocol.name, type: market.protocol.type, outputBehavior: market.protocol.outputBehavior },
      withdrawal: {
        requestedAmount: input.withdrawalAmount,
        requestedRawAmount: withdrawalBudget.toString(),
        actualAmount: formatUnits(totalWithdrawal, inputDecimals),
        actualRawAmount: totalWithdrawal.toString(),
        unusedRawAmount: (withdrawalBudget - totalWithdrawal).toString(),
      },
      fee: {
        amount: formatUnits(fee, inputDecimals), rawAmount: fee.toString(),
        networkRawAmount: BigInt(relayQuote.networkFee).toString(), serviceRawAmount: BigInt(relayQuote.serviceFee).toString(),
        serviceFeeBps: relayQuote.serviceFeeBps,
      },
      input: {
        token: market.inputAsset.token, symbol: market.inputAsset.symbol, decimals: market.inputAsset.decimals,
        amount: formatUnits(swapAmount, inputDecimals), rawAmount: swapAmount.toString(),
      },
      output: {
        token: market.outputAsset.token, symbol: market.outputAsset.symbol, decimals: market.outputAsset.decimals,
        estimatedAmount: formatUnits(market.quote.estimatedOutput, market.outputAsset.decimals),
        estimatedRawAmount: market.quote.estimatedOutput.toString(),
        recommendedMinimumAmount: formatUnits(market.quote.minimumOutput, market.outputAsset.decimals),
        recommendedMinimumRawAmount: market.quote.minimumOutput.toString(),
      },
      route: market.quote.routeLabel,
      slippageBips: market.slippageBips.toString(),
      relayer: normalizeAddress(relayQuote.relayer, config.family), relayerUrl: relayerClient.baseUrl,
      quoteId: relayQuote.id, quoteExpiresAt: new Date(expiry).toISOString(),
      advisory: true, preparationRefreshesQuote: true,
    };
  }
}
