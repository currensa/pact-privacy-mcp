import { normalizeAddress } from "../chain/address.js";
import { OperationService } from "../operations/service.js";
import { RelayerClient } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { asCircuitTier, decryptRefund } from "../refund/content.js";
import { refundState } from "../refund/state.js";
import type { RelayedRefundPlan } from "./types.js";

export class RelayedRefundPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}

  async prepare(input: {
    chainId: number;
    leafIndex: number;
    refunder: string;
    maximumFee?: string;
    relayerUrl: string;
  }) {
    await this.client.assertRelayedSupported(input.chainId);
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt refund data");
    const { config, runtime } = await this.client.chain(input.chainId);
    const { content } = await decryptRefund(this.client, input.chainId, input.leafIndex, password);
    const tier = asCircuitTier(content.tier);
    const token = normalizeAddress(content.token, config.family);
    const native = token === "0x0000000000000000000000000000000000000000";
    const web3 = new Web3Service(config, runtime);
    const details = native ? null : await web3.token(token);
    const decimals = details?.decimals ?? (config.nativeCurrency?.decimals ?? (config.family === "tron" ? 6 : 18));
    if (content.decimals !== undefined && content.decimals !== decimals) {
      throw new Error("Encrypted refund token decimals do not match the chain");
    }
    const state = await refundState(web3, content);
    const maximumFee = input.maximumFee === undefined ? undefined : web3.parseTokenAmount(input.maximumFee, decimals);
    if (maximumFee !== undefined && (maximumFee <= 0n || maximumFee >= state.refundAmount)) {
      throw new Error("Maximum relayer fee must be positive and less than the refund amount");
    }
    const refunder = normalizeAddress(input.refunder, config.family);
    await this.client.proofs.prepare("refund", tier);
    const relayerClient = new RelayerClient(input.relayerUrl);
    const quote = await relayerClient.quoteRefund({
      chainId: input.chainId,
      token,
      amount: state.refundAmount.toString(),
      tier,
    });
    const quoteExpiry = Date.parse(quote.expiresAt);
    if (!Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now()) throw new Error("Relayer returned an expired quote");
    const gravArc = normalizeAddress(config.gravArc, config.family);
    const relayer = normalizeAddress(quote.relayer, config.family);
    const fee = BigInt(quote.fee);
    if (
      (quote.operation !== undefined && quote.operation !== "refund")
      || quote.chainId !== input.chainId
      || normalizeAddress(quote.token, config.family) !== token
      || normalizeAddress(quote.gravArc, config.family) !== gravArc
      || quote.amount !== state.refundAmount.toString()
      || quote.tier !== tier
    ) throw new Error("Relayer quote does not match the prepared refund");
    if (fee <= 0n || fee >= state.refundAmount || fee * 1000n < state.refundAmount) {
      throw new Error("Relayer returned an invalid refund fee");
    }
    if (maximumFee !== undefined && fee > maximumFee) {
      throw new Error(`Relayer quote fee exceeds the accepted maximum (${fee} > ${maximumFee})`);
    }
    const plan: RelayedRefundPlan = {
      leafIndex: input.leafIndex,
      token,
      tokenSymbol: content.tokenSymbol ?? details?.symbol ?? config.nativeCurrency?.symbol ?? "native",
      decimals,
      tier,
      depositLeaf: content.depositLeaf,
      totalAllocated: state.totalAllocated.toString(),
      totalClaimedAtPreparation: state.totalClaimed.toString(),
      refundAmount: state.refundAmount.toString(),
      fee: fee.toString(),
      ...(maximumFee !== undefined ? { maximumFee: maximumFee.toString() } : {}),
      networkFee: BigInt(quote.networkFee).toString(),
      serviceFee: BigInt(quote.serviceFee).toString(),
      netRefund: (state.refundAmount - fee).toString(),
      refunder,
      relayer,
      relayerUrl: relayerClient.baseUrl,
      quoteId: quote.id,
      quoteExpiresAt: new Date(quoteExpiry).toISOString(),
      gravArc,
      expectedTransactions: ["relayed-refund"],
    };
    return this.operations.prepare("relayed-refund", input.chainId, plan, quoteExpiry - Date.now());
  }
}
