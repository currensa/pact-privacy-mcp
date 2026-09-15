import { createHash } from "node:crypto";
import { normalizeAddress } from "../chain/address.js";
import type { CanonicalAddress, RegisteredReceiver } from "../core/types.js";
import { depositRegistryDigest, NATIVE_TOKEN, type RequestedRecipient } from "../deposit/prepare.js";
import { selectDepositTier } from "../deposit/proof.js";
import { canonicalPlan } from "../operations/plan.js";
import { OperationService } from "../operations/service.js";
import { poseidonHash } from "../proof/poseidon.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service, type TokenDetails } from "../web3/service.js";
import { decryptAllocation } from "../withdraw/allocation.js";
import { protocolSnapshot, quoteDefi } from "./adapter.js";
import type { DefiPlan, DefiQuote } from "./types.js";

function receiver(row: RegisteredReceiver, family: "evm" | "tron") {
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.secretHash) || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(row.encPubkey)) {
    throw new Error(`Receiver has invalid account data: ${row.address}`);
  }
  return { ...row, canonical: normalizeAddress(row.address, family) };
}

function quoteDigest(quote: DefiQuote): string {
  return `0x${createHash("sha256").update(canonicalPlan({
    amountIn: quote.amountIn.toString(), estimatedOutput: quote.estimatedOutput.toString(),
    minimumOutput: quote.minimumOutput.toString(), routeLabel: quote.routeLabel, payload: quote.payload ?? null,
  })).digest("hex")}`;
}

export async function defiAsset(web3: Web3Service, value: string): Promise<{ token: CanonicalAddress; details: TokenDetails | null; decimals: number; symbol: string }> {
  const native = value.toLowerCase() === "native" || value.toLowerCase() === NATIVE_TOKEN
    || value.toLowerCase() === web3.chain.nativeCurrency?.symbol.toLowerCase();
  if (native) return {
    token: NATIVE_TOKEN, details: null,
    decimals: web3.chain.nativeCurrency?.decimals ?? (web3.chain.family === "tron" ? 6 : 18),
    symbol: web3.chain.nativeCurrency?.symbol ?? "native",
  };
  const details = await web3.token(value);
  return { token: normalizeAddress(details.address, web3.chain.family), details, decimals: details.decimals, symbol: details.symbol };
}

export type DefiQuoteInput = {
  chainId: number;
  allocationId: number;
  amount?: string | undefined;
  all?: boolean;
  protocol: string;
  outputToken: string;
  slippageBips?: number;
};

export type DefiMarketQuoteInput = {
  chainId: number;
  inputToken: string;
  amount: string;
  protocol: string;
  outputToken: string;
  slippageBips?: number;
};

export type PrepareDefiInput = DefiQuoteInput & {
  minimumOutput: string;
  destination?: string;
  excessRecipient?: string;
  recipients: RequestedRecipient[];
  privateRedeposit: boolean;
  refund: boolean;
};

export async function resolveDefiMarketQuote(client: PactPrivacyClient, input: DefiMarketQuoteInput) {
  const { config, runtime } = await client.chain(input.chainId);
  if (!config.pureRouter || !config.pactPrivacyDefiRouter) throw new Error("DeFi routers are not configured for this chain");
  const web3 = new Web3Service(config, runtime);
  const inputAsset = await defiAsset(web3, input.inputToken);
  const outputAsset = await defiAsset(web3, input.outputToken);
  if (inputAsset.token === outputAsset.token) throw new Error("Output token must differ from input token");
  const protocol = protocolSnapshot(config, input.protocol);
  if ((protocol.type === "sunswap-v4") !== (config.family === "tron")) throw new Error(`${protocol.name} does not support this chain family`);
  const swapAmount = web3.parseTokenAmount(input.amount, inputAsset.decimals);
  if (swapAmount <= 0n) throw new Error("DeFi amount must be positive");
  const slippageBips = BigInt(input.slippageBips ?? 50);
  if (slippageBips < 0n || slippageBips >= 10_000n) throw new Error("Slippage must be between 0 and 10000 basis points");
  const quote = await quoteDefi({
    chain: config, runtime, protocol, inputToken: inputAsset.token, outputToken: outputAsset.token,
    amount: swapAmount, inputDecimals: inputAsset.decimals, outputDecimals: outputAsset.decimals, slippageBips,
  });
  return { config, runtime, web3, inputAsset, outputAsset, protocol, swapAmount, slippageBips, quote };
}

export async function resolveDefiAllocation(client: PactPrivacyClient, input: Pick<DefiQuoteInput,
  "chainId" | "allocationId" | "protocol" | "outputToken" | "slippageBips"
>) {
  const { config, runtime } = await client.chain(input.chainId);
  if (!config.pureRouter || !config.pactPrivacyDefiRouter) throw new Error("DeFi routers are not configured for this chain");
  const password = client.environment.password;
  if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt the allocation");
  const web3 = new Web3Service(config, runtime);
  const { info } = await decryptAllocation(client, input.chainId, input.allocationId, password);
  const inputAsset = await defiAsset(web3, info.token);
  if (info.decimals !== undefined && info.decimals !== inputAsset.decimals) throw new Error("Encrypted allocation token decimals do not match the chain");
  const outputAsset = await defiAsset(web3, input.outputToken);
  if (inputAsset.token === outputAsset.token) throw new Error("Output token must differ from input token");
  const protocol = protocolSnapshot(config, input.protocol);
  if ((protocol.type === "sunswap-v4") !== (config.family === "tron")) throw new Error(`${protocol.name} does not support this chain family`);
  const nullifierHashValue = await poseidonHash([BigInt(info.nullifier)]);
  const state = await web3.claimedState(`0x${nullifierHashValue.toString(16).padStart(64, "0")}`);
  if (state.refunded) throw new Error("This allocation was refunded");
  const remaining = BigInt(info.amount) - state.claimed;
  if (remaining <= 0n) throw new Error("Nothing remains for DeFi");
  const slippageBips = BigInt(input.slippageBips ?? 50);
  if (slippageBips < 0n || slippageBips >= 10_000n) throw new Error("Slippage must be between 0 and 10000 basis points");
  return { config, runtime, web3, info, inputAsset, outputAsset, protocol, slippageBips, state, remaining };
}

export async function resolveDefiQuote(client: PactPrivacyClient, input: DefiQuoteInput) {
  if (!!input.all === (input.amount !== undefined)) throw new Error("Choose exactly one of --amount or --all");
  const resolved = await resolveDefiAllocation(client, input);
  const { config, runtime, web3, inputAsset, outputAsset, protocol, slippageBips, remaining } = resolved;
  const swapAmount = input.all ? remaining : web3.parseTokenAmount(input.amount!, inputAsset.decimals);
  const quote = await quoteDefi({
    chain: config, runtime, protocol, inputToken: inputAsset.token, outputToken: outputAsset.token,
    amount: swapAmount, inputDecimals: inputAsset.decimals, outputDecimals: outputAsset.decimals, slippageBips,
  });
  if (swapAmount > remaining) throw new Error("DeFi amount exceeds the remaining allocation");
  return { ...resolved, swapAmount, quote };
}

export async function buildDefiPlan(client: PactPrivacyClient, input: PrepareDefiInput): Promise<{ plan: DefiPlan; quote: DefiQuote }> {
  if (input.privateRedeposit === (input.destination !== undefined)) {
    throw new Error("Choose either --to or --private-redeposit");
  }
  if (!input.privateRedeposit && (input.recipients.length > 0 || input.refund)) {
    throw new Error("Re-deposit receivers and refund support require --private-redeposit");
  }
  const { config, web3, info, inputAsset, outputAsset, protocol, swapAmount, slippageBips, quote, state } = await resolveDefiQuote(client, input);
  if (input.privateRedeposit && config.family === "tron") throw new Error("Private re-deposit is not supported on TRON");
  if (input.excessRecipient !== undefined && (!input.privateRedeposit || protocol.outputBehavior !== "variable")) {
    throw new Error("An excess recipient is valid only for variable-output private re-deposit");
  }
  if (input.privateRedeposit && protocol.outputBehavior === "variable" && input.excessRecipient === undefined) {
    throw new Error("Variable-output private re-deposit requires --excess-recipient");
  }
  const minimumOutput = web3.parseTokenAmount(input.minimumOutput, outputAsset.decimals);
  if (quote.estimatedOutput < minimumOutput || quote.minimumOutput < minimumOutput) {
    throw new Error("The current DeFi quote is below the requested minimum output");
  }

  let recipients: DefiPlan["recipients"];
  let registryDigest: string | undefined;
  let depositorRegistryDigest: string | undefined;
  if (input.privateRedeposit) {
    if (input.recipients.length === 0) throw new Error("At least one re-deposit receiver is required");
    const registered = (await client.backend.users(config.family)).map((row) => receiver(row, config.family));
    const seen = new Set<string>();
    const values = input.recipients.map((requested) => {
      const address = normalizeAddress(requested.address, config.family);
      if (seen.has(address)) throw new Error(`Duplicate receiver: ${requested.address}`);
      seen.add(address);
      const account = registered.find((entry) => entry.canonical === address);
      if (!account) throw new Error(`Receiver is not registered: ${requested.address}`);
      return { address, amount: web3.parseTokenAmount(requested.amount, outputAsset.decimals), secretHash: account.secretHash, encPubkey: account.encPubkey };
    });
    selectDepositTier(values.length);
    const total = values.reduce((sum, value) => sum + value.amount, 0n);
    if (protocol.outputBehavior === "fixed" && total !== quote.estimatedOutput) {
      throw new Error("Private re-deposit receiver amounts must equal the fixed quoted output");
    }
    if (protocol.outputBehavior === "variable" && total > quote.minimumOutput) {
      throw new Error("Private re-deposit receiver amounts exceed the minimum quoted output");
    }
    recipients = values.map((value) => ({ address: value.address, amount: value.amount.toString() }));
    registryDigest = depositRegistryDigest(values.map((value) => ({ address: value.address, account: value.secretHash, key: value.encPubkey })));
    if (input.refund) {
      const account = await client.backend.account(config.family);
      if (!account.found || !account.secretHash || !account.encPubkey) throw new Error("Account must be initialized before enabling refund support");
      depositorRegistryDigest = depositRegistryDigest({ account: account.secretHash, key: account.encPubkey });
    }
  }
  return { quote, plan: {
    allocationId: input.allocationId, leafIndex: info.leafIndex, tier: info.tier as DefiPlan["tier"], allocationAmount: info.amount,
    claimedAtPreparation: state.claimed.toString(), nonceAtPreparation: state.nonce.toString(),
    inputToken: inputAsset.token, inputTokenSymbol: info.tokenSymbol ?? inputAsset.symbol, inputDecimals: inputAsset.decimals,
    outputToken: outputAsset.token, outputTokenSymbol: outputAsset.symbol, outputDecimals: outputAsset.decimals,
    protocol, swapAmount: swapAmount.toString(), minimumOutput: minimumOutput.toString(), estimatedOutput: quote.estimatedOutput.toString(),
    slippageBips: slippageBips.toString(), privateRedeposit: input.privateRedeposit,
    ...(input.excessRecipient ? { excessRecipient: normalizeAddress(input.excessRecipient, config.family) } : {}),
    ...(input.destination ? { destination: normalizeAddress(input.destination, config.family) } : {}),
    ...(recipients && registryDigest ? { recipients, registryDigest } : {}), refund: input.refund,
    ...(depositorRegistryDigest ? { depositorRegistryDigest } : {}),
    defiFee: "0", totalWithdrawal: swapAmount.toString(),
    expectedTransactions: ["defi"],
  } };
}

export class DefiPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}
  async prepare(input: PrepareDefiInput) {
    const { plan, quote } = await buildDefiPlan(this.client, input);
    return this.operations.prepare("defi", input.chainId, { ...plan, quoteDigest: quoteDigest(quote) });
  }
}
