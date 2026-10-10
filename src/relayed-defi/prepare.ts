import { normalizeAddress } from "../chain/address.js";
import { formatUnits } from "ethers";
import { buildDefiPlan, resolveDefiAllocation, type PrepareDefiInput } from "../defi/prepare.js";
import type { RelayedDefiPlan } from "../defi/types.js";
import { OperationService } from "../operations/service.js";
import { RelayerClient } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { selectDepositTier } from "../deposit/proof.js";

export class RelayedDefiPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}

  async prepare(input: Omit<PrepareDefiInput, "amount" | "all"> & {
    withdrawalAmount?: string;
    withdrawAll: boolean;
    maximumFee?: string;
    relayerUrl: string;
  }) {
    await this.client.assertRelayedSupported(input.chainId);
    if (input.withdrawAll === (input.withdrawalAmount !== undefined)) {
      throw new Error("Choose exactly one of --withdraw-amount or --withdraw-all");
    }
    const { withdrawalAmount, withdrawAll, maximumFee: maximumFeeInput, relayerUrl, ...defiInput } = input;
    const resolved = await resolveDefiAllocation(this.client, defiInput);
    const selected = await this.client.chain(input.chainId);
    if (!selected.config.pactPrivacyDefiRouter) throw new Error("DeFi router is not configured");
    const tier = resolved.info.tier as import("../proof/artifact-cache.js").CircuitTier;
    await this.client.proofs.prepare("withdraw", tier);
    const web3 = new (await import("../web3/service.js")).Web3Service(selected.config, selected.runtime);
    const decimals = resolved.inputAsset.decimals;
    const withdrawalBudget = withdrawAll ? resolved.remaining : web3.parseTokenAmount(withdrawalAmount!, decimals);
    if (withdrawalBudget <= 0n || withdrawalBudget > resolved.remaining) throw new Error("Withdrawal amount exceeds the remaining allocation");
    const maximumFee = maximumFeeInput === undefined ? undefined : web3.parseTokenAmount(maximumFeeInput, decimals);
    if (maximumFee !== undefined && maximumFee <= 0n) throw new Error("Maximum relayer fee must be positive");
    const relayerClient = new RelayerClient(relayerUrl);
    if (input.privateRedeposit && input.recipients.length === 0) throw new Error("At least one re-deposit receiver is required");
    const redepositTier = input.privateRedeposit ? selectDepositTier(input.recipients.length) : undefined;
    const quote = await relayerClient.quoteDefi({
      chainId: input.chainId, token: resolved.inputAsset.token, amount: withdrawalBudget.toString(), tier,
      ...(redepositTier === undefined ? {} : { privateRedeposit: true, redepositTier }),
    });
    if (BigInt(quote.amount) <= 0n || BigInt(quote.amount) + BigInt(quote.fee) > withdrawalBudget) {
      throw new Error("Relayer quote exceeds the requested withdrawal amount");
    }
    const plan = (await buildDefiPlan(this.client, {
      ...defiInput, all: false, amount: formatUnits(BigInt(quote.amount), decimals),
    })).plan;
    const expiry = Date.parse(quote.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Relayer returned an expired quote");
    const defiRouter = normalizeAddress(selected.config.pactPrivacyDefiRouter, selected.config.family);
    const fee = BigInt(quote.fee);
    if (quote.operation !== undefined && quote.operation !== "defi") throw new Error("Relayer quote is not for DeFi");
    if (quote.chainId !== input.chainId || normalizeAddress(quote.token, selected.config.family) !== plan.inputToken
      || quote.amount !== plan.swapAmount || quote.tier !== plan.tier
      || Boolean(quote.privateRedeposit) !== plan.privateRedeposit
      || (quote.redepositTier ?? null) !== (redepositTier ?? null)
      || normalizeAddress(quote.defiRouter ?? quote.gravArc, selected.config.family) !== defiRouter) {
      throw new Error("Relayer quote does not match the prepared DeFi operation");
    }
    if (fee <= 0n || (maximumFee !== undefined && fee > maximumFee)) throw new Error("Relayer DeFi fee exceeds the accepted maximum");
    const totalWithdrawal = BigInt(plan.swapAmount) + fee;
    if (BigInt(plan.claimedAtPreparation) + totalWithdrawal > BigInt(plan.allocationAmount)) {
      throw new Error("Swap amount plus relayer fee exceeds the remaining allocation");
    }
    const relayed: RelayedDefiPlan = {
      ...plan, defiFee: fee.toString(), networkFee: BigInt(quote.networkFee).toString(), serviceFee: BigInt(quote.serviceFee).toString(),
      ...(maximumFee === undefined ? {} : { maximumFee: maximumFee.toString() }),
      withdrawalBudget: withdrawalBudget.toString(), totalWithdrawal: totalWithdrawal.toString(),
      relayer: normalizeAddress(quote.relayer, selected.config.family), relayerUrl: relayerClient.baseUrl,
      quoteId: quote.id, quoteExpiresAt: new Date(expiry).toISOString(), defiRouter,
      expectedTransactions: ["relayed-defi"],
    };
    return this.operations.prepare("relayed-defi", input.chainId, relayed, expiry - Date.now());
  }
}
