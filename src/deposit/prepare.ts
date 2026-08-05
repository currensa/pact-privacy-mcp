import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { normalizeAddress } from "../chain/address.js";
import type { CanonicalAddress, RegisteredReceiver } from "../core/types.js";
import { OperationService } from "../operations/service.js";
import { canonicalPlan } from "../operations/plan.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { selectDepositTier } from "./proof.js";
import type { DepositPlan, DepositReceiver } from "./types.js";

export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as CanonicalAddress;

export type RequestedRecipient = { address: string; amount: string };

export function depositRegistryDigest(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalPlan({ value })).digest("hex")}`;
}

function receiverRecord(row: RegisteredReceiver, family: "evm" | "tron"): RegisteredReceiver & { canonical: CanonicalAddress } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.secretHash)) throw new Error(`Receiver has invalid account data: ${row.address}`);
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(row.encPubkey)) throw new Error(`Receiver has no valid encryption key: ${row.address}`);
  return { ...row, canonical: normalizeAddress(row.address, family) };
}

function csvFields(line: string): string[] {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(value.trim()); value = "";
    } else value += character;
  }
  if (quoted) throw new Error("Payroll CSV contains an unterminated quote");
  fields.push(value.trim());
  return fields;
}

export async function readDepositRecipients(values: string[], csvPath?: string): Promise<RequestedRecipient[]> {
  const recipients = values.map((value) => {
    const separator = value.lastIndexOf(":");
    if (separator <= 0 || separator === value.length - 1) throw new Error(`Receiver must use address:amount: ${value}`);
    return { address: value.slice(0, separator), amount: value.slice(separator + 1) };
  });
  if (csvPath) {
    const lines = (await readFile(csvPath, "utf8")).split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    const header = lines.shift();
    if (!header) throw new Error("Payroll CSV is empty");
    const columns = csvFields(header).map((column) => column.toLowerCase());
    const addressIndex = columns.indexOf("address");
    const amountIndex = columns.indexOf("amount");
    if (addressIndex < 0 || amountIndex < 0) throw new Error("Payroll CSV requires address,amount columns");
    lines.forEach((line, index) => {
      const fields = csvFields(line);
      const address = fields[addressIndex];
      const amount = fields[amountIndex];
      if (!address || !amount) throw new Error(`Payroll CSV row ${index + 2} requires address and amount`);
      recipients.push({ address, amount });
    });
  }
  if (recipients.length === 0) throw new Error("At least one receiver is required");
  return recipients;
}

export class DepositPreparationService {
  constructor(private readonly client: PactPrivacyClient, private readonly operations = new OperationService()) {}

  async prepare(input: {
    chainId: number;
    token: string;
    recipients: RequestedRecipient[];
    refund: boolean;
  }) {
    const { config, runtime } = await this.client.chain(input.chainId);
    const web3 = new Web3Service(config, runtime);
    const native = input.token.toLowerCase() === "native" || input.token.toLowerCase() === NATIVE_TOKEN;
    const token = native ? null : await web3.token(input.token);
    const tokenAddress = native ? NATIVE_TOKEN : normalizeAddress(token!.address, config.family);
    const decimals = native ? (config.nativeCurrency?.decimals ?? (config.family === "tron" ? 6 : 18)) : token!.decimals;
    const tokenSymbol = native ? (config.nativeCurrency?.symbol ?? "native") : token!.symbol;
    const registered = (await this.client.backend.users(config.family)).map((row) => receiverRecord(row, config.family));
    const seen = new Set<string>();
    const receivers: DepositReceiver[] = input.recipients.map((requested) => {
      const address = normalizeAddress(requested.address, config.family);
      if (seen.has(address)) throw new Error(`Duplicate receiver: ${requested.address}`);
      seen.add(address);
      const account = registered.find((row) => row.canonical === address);
      if (!account) throw new Error(`Receiver is not registered: ${requested.address}`);
      const amount = web3.parseTokenAmount(requested.amount, decimals);
      return { address, amount, secretHash: account.secretHash, encPubkey: account.encPubkey };
    });
    const tier = selectDepositTier(receivers.length);
    const totalAmount = receivers.reduce((sum, receiver) => sum + receiver.amount, 0n);
    const balance = native ? await web3.nativeBalance() : await web3.tokenBalance(tokenAddress);
    if (BigInt(balance.raw) < totalAmount) throw new Error(`Insufficient ${tokenSymbol} balance`);
    const allowance = native
      ? { raw: totalAmount.toString() }
      : await web3.allowance(tokenAddress, config.gravArc);

    let depositorRegistryDigest: string | undefined;
    if (input.refund) {
      const account = await this.client.backend.account(config.family);
      if (!account.found || !account.secretHash || !account.encPubkey) {
        throw new Error("Account must be initialized before enabling refund support");
      }
      depositorRegistryDigest = depositRegistryDigest({ account: account.secretHash, key: account.encPubkey });
    }

    const backendPath = await this.client.backend.depositPath(input.chainId);
    const onChainNextIndex = await web3.depositNextIndex();
    if (backendPath.nextIndex !== onChainNextIndex) {
      throw new Error(`Scanner is out of sync: backend leaf ${backendPath.nextIndex}, chain leaf ${onChainNextIndex}`);
    }
    const currentAllowance = BigInt(allowance.raw);
    const approvalRequired = !native && currentAllowance < totalAmount;
    const plan: DepositPlan = {
      token: tokenAddress,
      tokenSymbol,
      decimals,
      native,
      recipients: receivers.map((receiver) => ({ address: receiver.address, amount: receiver.amount.toString() })),
      registryDigest: depositRegistryDigest(receivers.map((receiver) => ({
        address: receiver.address,
        account: receiver.secretHash,
        key: receiver.encPubkey,
      }))),
      totalAmount: totalAmount.toString(),
      tier,
      refund: input.refund,
      ...(depositorRegistryDigest ? { depositorRegistryDigest } : {}),
      allowance: { current: currentAllowance.toString(), required: totalAmount.toString(), approvalRequired },
      expectedTransactions: [...(approvalRequired ? ["approval"] : []), "deposit"],
    };
    return this.operations.prepare("deposit", input.chainId, plan);
  }
}
