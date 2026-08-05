import { Contract, MaxUint256, formatUnits, getAddress, parseUnits } from "ethers";
import { TronWeb } from "tronweb";
import { displayAddress, normalizeAddress, tronBase58FromCanonical } from "../chain/address.js";
import type { ChainDetails } from "../core/types.js";
import type { ChainRuntime } from "../chain/runtime.js";
import { FUNGIBLE_TOKEN_ABI, GRAVARC_STATE_ABI } from "./abi.js";

type TokenContract = {
  balanceOf(address: string): { call(): Promise<unknown> };
  allowance(owner: string, spender: string): { call(): Promise<unknown> };
  decimals(): { call(): Promise<unknown> };
  symbol(): { call(): Promise<unknown> };
  approve(spender: string, amount: string): { send(options: Record<string, unknown>): Promise<unknown> };
  transfer(to: string, amount: string): { send(options: Record<string, unknown>): Promise<unknown> };
};

type GravArcStateContract = {
  nextIndex(): { call(): Promise<unknown> };
  nullifierHashes(hash: string): { call(): Promise<unknown> };
  refundedNullifierHashes(hash: string): { call(): Promise<unknown> };
};

export type TokenDetails = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

function bigintValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) return BigInt(String(value));
  throw new Error("Contract returned an invalid integer");
}

function transactionId(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const id = record.txid ?? record.txID ?? record.transaction;
    if (typeof id === "string" && id) return id;
  }
  throw new Error("TRON transaction was submitted without a transaction ID");
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return Boolean(value);
}

export class Web3Service {
  constructor(readonly chain: ChainDetails, readonly runtime: ChainRuntime) {}

  private canonicalToken(value: string): TokenDetails["address"] {
    const configured = this.chain.erc20Tokens.filter((token) => token.symbol.toLowerCase() === value.toLowerCase());
    if (configured.length > 1) throw new Error(`Token symbol is ambiguous: ${value}`);
    if (configured[0]) return configured[0].address;
    return normalizeAddress(value, this.chain.family);
  }

  private configuredToken(address: string): { symbol: string; name: string; address: string } {
    const token = this.chain.erc20Tokens.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    return token ?? { symbol: "TOKEN", name: "Unconfigured token", address };
  }

  private tronToken(address: string): TokenContract {
    return this.runtime.family === "tron"
      ? this.runtime.tronWeb.contract(FUNGIBLE_TOKEN_ABI as never, tronBase58FromCanonical(address)) as unknown as TokenContract
      : (() => { throw new Error("Not a TRON runtime"); })();
  }

  async token(value: string): Promise<TokenDetails> {
    const address = this.canonicalToken(value);
    const configured = this.configuredToken(address);
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(address), FUNGIBLE_TOKEN_ABI, this.runtime.provider);
      const [decimals, symbol] = await Promise.all([
        contract.getFunction("decimals").staticCall() as Promise<bigint>,
        contract.getFunction("symbol").staticCall() as Promise<string>,
      ]);
      return { ...configured, symbol, decimals: Number(decimals) };
    }
    const contract = this.tronToken(address);
    const [decimals, symbol] = await Promise.all([contract.decimals().call(), contract.symbol().call()]);
    return { ...configured, symbol: String(symbol), decimals: Number(bigintValue(decimals)) };
  }

  async tokens(): Promise<TokenDetails[]> {
    return Promise.all(this.chain.erc20Tokens.map((token) => this.token(token.address)));
  }

  normalizeAccount(value?: string): { canonical: string; display: string } {
    const fallback = this.runtime.family === "evm"
      ? this.runtime.wallet.address
      : this.runtime.tronWeb.defaultAddress.base58;
    if (!value && !fallback) throw new Error("Local wallet address is unavailable");
    const canonical = normalizeAddress(value ?? String(fallback), this.chain.family);
    return { canonical, display: displayAddress(canonical, this.chain.family) };
  }

  async nativeBalance(address?: string): Promise<{ raw: string; formatted: string }> {
    const account = this.normalizeAccount(address);
    const decimals = this.chain.nativeCurrency?.decimals ?? (this.runtime.family === "tron" ? 6 : 18);
    const raw = this.runtime.family === "evm"
      ? await this.runtime.provider.getBalance(account.canonical)
      : BigInt(await this.runtime.tronWeb.trx.getBalance(account.display));
    return { raw: raw.toString(), formatted: formatUnits(raw, decimals) };
  }

  async tokenBalance(tokenValue: string, address?: string): Promise<{ token: TokenDetails; raw: string; formatted: string }> {
    const token = await this.token(tokenValue);
    const account = this.normalizeAccount(address);
    let raw: bigint;
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(token.address), FUNGIBLE_TOKEN_ABI, this.runtime.provider);
      raw = await contract.getFunction("balanceOf").staticCall(account.canonical) as bigint;
    } else {
      raw = bigintValue(await this.tronToken(token.address).balanceOf(account.display).call());
    }
    return { token, raw: raw.toString(), formatted: formatUnits(raw, token.decimals) };
  }

  resolveSpender(value: string): string {
    const aliases: Record<string, string | undefined> = {
      gravarc: this.chain.gravArc,
      "pure-router": this.chain.pureRouter,
      "defi-router": this.chain.pactPrivacyDefiRouter,
    };
    const address = aliases[value.toLowerCase()] ?? value;
    if (!address) throw new Error(`Spender is not configured: ${value}`);
    return normalizeAddress(address, this.chain.family);
  }

  async allowance(tokenValue: string, spenderValue: string, owner?: string): Promise<{ token: TokenDetails; spender: string; raw: string; formatted: string }> {
    const token = await this.token(tokenValue);
    const account = this.normalizeAccount(owner);
    const spender = this.resolveSpender(spenderValue);
    let raw: bigint;
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(token.address), FUNGIBLE_TOKEN_ABI, this.runtime.provider);
      raw = await contract.getFunction("allowance").staticCall(account.canonical, spender) as bigint;
    } else {
      raw = bigintValue(await this.tronToken(token.address).allowance(account.display, displayAddress(spender, "tron")).call());
    }
    return { token, spender: displayAddress(spender, this.chain.family), raw: raw.toString(), formatted: formatUnits(raw, token.decimals) };
  }

  async transactionStatus(hash: string): Promise<Record<string, unknown>> {
    if (this.runtime.family === "evm") {
      const receipt = await this.runtime.provider.getTransactionReceipt(hash);
      if (receipt) return {
        hash,
        state: receipt.status === 1 ? "confirmed" : "failed",
        blockNumber: receipt.blockNumber,
        confirmations: await receipt.confirmations(),
      };
      const transaction = await this.runtime.provider.getTransaction(hash);
      return { hash, state: transaction ? "pending" : "not_found" };
    }
    const info = await this.runtime.tronWeb.trx.getTransactionInfo(hash).catch(() => undefined);
    if (info && Object.keys(info).length > 0) return {
      hash,
      state: info.result === "FAILED" ? "failed" : "confirmed",
      blockNumber: info.blockNumber,
      ...(info.resMessage ? { error: TronWeb.toUtf8(info.resMessage) } : {}),
    };
    const transaction = await this.runtime.tronWeb.trx.getTransaction(hash).catch(() => undefined);
    return { hash, state: transaction ? "pending" : "not_found" };
  }

  parseTokenAmount(value: string, decimals: number): bigint {
    const amount = parseUnits(value, decimals);
    if (amount <= 0n) throw new Error("Amount must be greater than zero");
    return amount;
  }

  async approve(tokenValue: string, spenderValue: string, amountValue: string): Promise<Record<string, unknown>> {
    const token = await this.token(tokenValue);
    const spender = this.resolveSpender(spenderValue);
    const amount = amountValue.toLowerCase() === "unlimited" ? MaxUint256 : this.parseTokenAmount(amountValue, token.decimals);
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(token.address), FUNGIBLE_TOKEN_ABI, this.runtime.wallet);
      const transaction = await contract.getFunction("approve").send(spender, amount) as { hash: string };
      return { hash: transaction.hash, amount: amount.toString(), token: token.symbol, spender: displayAddress(spender, "evm") };
    }
    const result = await this.tronToken(token.address).approve(displayAddress(spender, "tron"), amount.toString()).send({ keepTxID: true });
    return { hash: transactionId(result), amount: amount.toString(), token: token.symbol, spender: displayAddress(spender, "tron") };
  }

  async transferNative(toValue: string, amountValue: string): Promise<Record<string, unknown>> {
    const to = normalizeAddress(toValue, this.chain.family);
    const decimals = this.chain.nativeCurrency?.decimals ?? (this.runtime.family === "tron" ? 6 : 18);
    const amount = this.parseTokenAmount(amountValue, decimals);
    if (this.runtime.family === "evm") {
      const transaction = await this.runtime.wallet.sendTransaction({ to, value: amount });
      return { hash: transaction.hash, amount: amount.toString(), to: displayAddress(to, "evm") };
    }
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("TRON native amount exceeds the safe SUN range");
    const result = await this.runtime.tronWeb.trx.sendTransaction(displayAddress(to, "tron"), Number(amount));
    if (!result.result) throw new Error(result.message ? TronWeb.toUtf8(result.message) : `TRON broadcast failed: ${result.code}`);
    return { hash: result.txid, amount: amount.toString(), to: displayAddress(to, "tron") };
  }

  async transferToken(tokenValue: string, toValue: string, amountValue: string): Promise<Record<string, unknown>> {
    const token = await this.token(tokenValue);
    const to = normalizeAddress(toValue, this.chain.family);
    const amount = this.parseTokenAmount(amountValue, token.decimals);
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(token.address), FUNGIBLE_TOKEN_ABI, this.runtime.wallet);
      const transaction = await contract.getFunction("transfer").send(to, amount) as { hash: string };
      return { hash: transaction.hash, amount: amount.toString(), token: token.symbol, to: displayAddress(to, "evm") };
    }
    const result = await this.tronToken(token.address).transfer(displayAddress(to, "tron"), amount.toString()).send({ keepTxID: true });
    return { hash: transactionId(result), amount: amount.toString(), token: token.symbol, to: displayAddress(to, "tron") };
  }

  async claimedState(nullifierHash: string): Promise<{ claimed: bigint; nonce: bigint; refunded: boolean }> {
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(this.chain.gravArc), GRAVARC_STATE_ABI, this.runtime.provider);
      const state = await contract.getFunction("nullifierHashes").staticCall(nullifierHash) as [bigint, bigint];
      const refunded = await contract.getFunction("refundedNullifierHashes").staticCall(nullifierHash) as boolean;
      return { claimed: state[0], nonce: state[1], refunded };
    }
    const contract = this.runtime.tronWeb.contract(
      GRAVARC_STATE_ABI as never, tronBase58FromCanonical(this.chain.gravArc),
    ) as unknown as GravArcStateContract;
    const [state, refunded] = await Promise.all([
      contract.nullifierHashes(nullifierHash).call(),
      contract.refundedNullifierHashes(nullifierHash).call(),
    ]);
    const values = state as Record<string, unknown> & { 0?: unknown; 1?: unknown };
    return {
      claimed: bigintValue(values.claimed ?? values[0] ?? 0),
      nonce: bigintValue(values.nextNonce ?? values[1] ?? 0),
      refunded: booleanValue(refunded),
    };
  }

  async depositNextIndex(): Promise<number> {
    let value: bigint;
    if (this.runtime.family === "evm") {
      const contract = new Contract(getAddress(this.chain.gravArc), GRAVARC_STATE_ABI, this.runtime.provider);
      value = await contract.getFunction("nextIndex").staticCall() as bigint;
    } else {
      const contract = this.runtime.tronWeb.contract(
        GRAVARC_STATE_ABI as never, tronBase58FromCanonical(this.chain.gravArc),
      ) as unknown as GravArcStateContract;
      value = bigintValue(await contract.nextIndex().call());
    }
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error("On-chain deposit index is invalid");
    return result;
  }
}
