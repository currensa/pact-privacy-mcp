import { normalizeAddress } from "../chain/address.js";
import type { CircuitTier } from "../proof/artifact-cache.js";
import { poseidonHash } from "../proof/poseidon.js";
import { OperationService } from "../operations/service.js";
import { RelayerClient } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptAllocation } from "../withdraw/allocation.js";
import type { RelayedWithdrawPlan } from "./types.js";

const TIERS = new Set([8, 16, 32, 64, 128]);

export class RelayedWithdrawPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}

  async prepare(input: {
    chainId: number;
    allocationId: string;
    amount?: string;
    all: boolean;
    recipient: string;
    maximumFee?: string;
    relayerUrl: string;
  }) {
    if (input.all === (input.amount !== undefined)) throw new Error("Choose exactly one of --amount or --all");
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt the allocation");
    const { config, runtime } = await this.client.assertAccount(input.chainId);
    const web3 = new Web3Service(config, runtime);
    const { info, source } = await decryptAllocation(this.client, input.chainId, input.allocationId, password);
    if (!TIERS.has(info.tier)) throw new Error(`Unsupported withdrawal tier: ${info.tier}`);
    const token = normalizeAddress(info.token, config.family);
    const native = token === "0x0000000000000000000000000000000000000000";
    const details = native ? null : await web3.token(token);
    const decimals = details?.decimals ?? (config.nativeCurrency?.decimals ?? (config.family === "tron" ? 6 : 18));
    const tokenSymbol = info.tokenSymbol ?? details?.symbol ?? config.nativeCurrency?.symbol ?? "native";
    if (info.decimals !== undefined && info.decimals !== decimals) throw new Error("Encrypted allocation token decimals do not match the chain");
    const nullifierHashValue = await poseidonHash([BigInt(info.nullifier)]);
    const state = await web3.claimedState(`0x${nullifierHashValue.toString(16).padStart(64, "0")}`);
    const total = BigInt(info.amount);
    if (state.refunded) throw new Error("This allocation was refunded");
    const remaining = total - state.claimed;
    if (remaining <= 0n) throw new Error("Nothing remains to withdraw");
    const expectedAmount = input.all ? remaining : web3.parseTokenAmount(input.amount!, decimals);
    if (expectedAmount <= 0n || expectedAmount > remaining) throw new Error("Withdrawal amount exceeds the remaining allocation");
    const maximumFee = input.maximumFee === undefined ? undefined : web3.parseTokenAmount(input.maximumFee, decimals);
    if (maximumFee !== undefined && (maximumFee <= 0n || maximumFee >= expectedAmount)) {
      throw new Error("Maximum relayer fee must be positive and less than the withdrawal amount");
    }
    const recipient = normalizeAddress(input.recipient, config.family);
    // Fetch and verify large artifacts before starting the short-lived fee quote.
    await this.client.proofs.prepare("withdraw", info.tier as CircuitTier);
    const relayerClient = new RelayerClient(input.relayerUrl);
    const quote = await relayerClient.quoteWithdraw({
      chainId: input.chainId,
      token,
      amount: expectedAmount.toString(),
      tier: info.tier,
    });
    const quoteExpiry = Date.parse(quote.expiresAt);
    if (!Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now()) throw new Error("Relayer returned an expired quote");
    const gravArc = normalizeAddress(config.gravArc, config.family);
    const relayer = normalizeAddress(quote.relayer, config.family);
    const fee = BigInt(quote.fee);
    if (
      (quote.operation !== undefined && quote.operation !== "withdraw")
      || quote.chainId !== input.chainId
      || normalizeAddress(quote.token, config.family) !== token
      || normalizeAddress(quote.gravArc, config.family) !== gravArc
      || quote.amount !== expectedAmount.toString()
      || quote.tier !== info.tier
    ) throw new Error("Relayer quote does not match the prepared withdrawal");
    if (fee <= 0n || fee >= expectedAmount) throw new Error("Relayer returned an invalid fee");
    if (maximumFee !== undefined && fee > maximumFee) {
      throw new Error(`Relayer quote fee exceeds the accepted maximum (${fee} > ${maximumFee})`);
    }
    const plan: RelayedWithdrawPlan = {
      allocationId: input.allocationId,
      source,
      leafIndex: info.leafIndex,
      token,
      tokenSymbol,
      decimals,
      tier: info.tier as CircuitTier,
      allocationAmount: total.toString(),
      claimedAtPreparation: state.claimed.toString(),
      nonceAtPreparation: state.nonce.toString(),
      expectedAmount: expectedAmount.toString(),
      fee: fee.toString(),
      ...(maximumFee !== undefined ? { maximumFee: maximumFee.toString() } : {}),
      networkFee: BigInt(quote.networkFee).toString(),
      serviceFee: BigInt(quote.serviceFee).toString(),
      netAmount: (expectedAmount - fee).toString(),
      recipient,
      relayer,
      relayerUrl: relayerClient.baseUrl,
      quoteId: quote.id,
      quoteExpiresAt: new Date(quoteExpiry).toISOString(),
      gravArc,
      expectedTransactions: ["relayed-withdraw"],
    };
    return this.operations.prepare("relayed-withdraw", input.chainId, plan, quoteExpiry - Date.now());
  }
}
