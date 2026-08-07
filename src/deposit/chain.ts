import { Interface, keccak256 } from "ethers";
import { TronWeb } from "tronweb";
import { tronBase58FromCanonical } from "../chain/address.js";
import type { ChainDetails } from "../core/types.js";
import type { ChainRuntime } from "../chain/runtime.js";
import { FUNGIBLE_TOKEN_ABI } from "../web3/abi.js";
import { GRAVARC_DEPOSIT_ABI, GRAVARC_REFUND_ABI, GRAVARC_WITHDRAW_ABI } from "./abi.js";
import type { DepositProofResult, DepositPlan } from "./types.js";
import type { StoredSignedTransaction } from "./payload-store.js";

const TRON_FALLBACK_FEE_LIMIT = 1_500_000_000;
const TRON_MAX_FEE_LIMIT = 15_000_000_000;
const TRON_MIN_FEE_LIMIT = 100_000_000;

export type DepositReceipt = {
  hash: string;
  blockNumber: number;
  logs: Array<{ data: string; topics: string[] }>;
};

export class ChainTransactionFailedError extends Error {
  constructor(readonly hash: string, message: string) {
    super(message);
    this.name = "ChainTransactionFailedError";
  }
}

function tronError(message: string | undefined, fallback: string): Error {
  return new Error(message ? TronWeb.toUtf8(message) : fallback);
}

export class DepositChainGateway {
  constructor(private readonly chain: ChainDetails, private readonly runtime: ChainRuntime, private readonly privateKey: string) {}

  private async tronFeeLimit(
    contract: string,
    selector: string,
    parameters: Array<{ type: string; value: unknown }>,
    callValue: number,
    owner: string,
  ): Promise<number> {
    if (this.runtime.family !== "tron") throw new Error("Not a TRON runtime");
    try {
      const [estimate, chainParameters] = await Promise.all([
        this.runtime.tronWeb.transactionBuilder.estimateEnergy(contract, selector, { callValue }, parameters, owner),
        this.runtime.tronWeb.trx.getChainParameters(),
      ]);
      const energyPrice = chainParameters.find((item) => item.key === "getEnergyFee")?.value ?? 100;
      return Math.min(TRON_MAX_FEE_LIMIT, Math.max(TRON_MIN_FEE_LIMIT, Math.ceil(estimate.energy_required * energyPrice * 1.2)));
    } catch {
      return TRON_FALLBACK_FEE_LIMIT;
    }
  }

  private async signTron(
    contract: string,
    selector: string,
    parameters: Array<{ type: string; value: unknown }>,
    callValue = 0,
  ): Promise<StoredSignedTransaction["raw"]> {
    if (this.runtime.family !== "tron") throw new Error("Not a TRON runtime");
    const owner = this.runtime.tronWeb.defaultAddress.base58;
    if (!owner) throw new Error("TRON signer address is unavailable");
    const feeLimit = await this.tronFeeLimit(contract, selector, parameters, callValue, owner);
    const built = await this.runtime.tronWeb.transactionBuilder.triggerSmartContract(
      contract, selector, { feeLimit, callValue }, parameters, owner,
    );
    if (!built.result?.result) throw tronError(built.result?.message, "Could not build TRON transaction");
    const extended = await this.runtime.tronWeb.transactionBuilder.extendExpiration(built.transaction, 5 * 60);
    return await this.runtime.tronWeb.trx.signTransaction(extended, this.privateKey.slice(2)) as unknown as Record<string, unknown>;
  }

  async signApproval(token: string, amount: bigint): Promise<StoredSignedTransaction> {
    if (this.runtime.family === "evm") {
      const data = new Interface(FUNGIBLE_TOKEN_ABI).encodeFunctionData("approve", [this.chain.gravArc, amount]);
      const request = await this.runtime.wallet.populateTransaction({ to: token, data, gasLimit: 150_000n });
      const raw = await this.runtime.wallet.signTransaction(request);
      return { purpose: "approval", family: "evm", hash: keccak256(raw), raw };
    }
    const raw = await this.signTron(
      tronBase58FromCanonical(token),
      "approve(address,uint256)",
      [{ type: "address", value: this.chain.gravArc }, { type: "uint256", value: amount }],
    );
    const hash = String((raw as Record<string, unknown>).txID ?? "");
    return { purpose: "approval", family: "tron", hash, raw };
  }

  async signDeposit(plan: DepositPlan, proof: DepositProofResult): Promise<StoredSignedTransaction> {
    const argument = {
      pA: proof.proof.pA.map(BigInt),
      pB: proof.proof.pB.map((row) => row.map(BigInt)),
      pC: proof.proof.pC.map(BigInt),
      newRoot: BigInt(proof.newDepositRoot),
      depositLeaf: BigInt(proof.depositLeaf),
      totalAmount: proof.totalAmount,
      token: plan.token,
      tier: proof.tier,
    };
    if (this.runtime.family === "evm") {
      const data = new Interface(GRAVARC_DEPOSIT_ABI).encodeFunctionData("deposit", [argument]);
      const request = await this.runtime.wallet.populateTransaction({
        to: this.chain.gravArc,
        data,
        value: plan.native ? proof.totalAmount : 0n,
        gasLimit: 3_000_000n,
      });
      const raw = await this.runtime.wallet.signTransaction(request);
      return { purpose: "deposit", family: "evm", hash: keccak256(raw), raw };
    }
    const callValue = plan.native ? proof.totalAmount : 0n;
    if (callValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("TRX deposit exceeds the safe SUN range");
    const tupleType = "(uint256[2],uint256[2][2],uint256[2],uint256,uint256,uint256,address,uint8)";
    const tupleValue = [
      argument.pA, argument.pB, argument.pC, argument.newRoot, argument.depositLeaf,
      argument.totalAmount, argument.token, argument.tier,
    ];
    const raw = await this.signTron(
      tronBase58FromCanonical(this.chain.gravArc),
      `deposit(${tupleType})`,
      [{ type: tupleType, value: tupleValue }],
      Number(callValue),
    );
    const hash = String((raw as Record<string, unknown>).txID ?? "");
    return { purpose: "deposit", family: "tron", hash, raw };
  }

  async signWithdraw(argument: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
    nullifierHash: string;
    recipient: string;
    claimedAmount: bigint;
    token: string;
    tier: number;
    depositRoot: bigint;
    expectedAmount: bigint;
    fee: bigint;
    relayer: string;
    nonce: bigint;
  }): Promise<StoredSignedTransaction> {
    const value = {
      ...argument,
      pA: argument.pA.map(BigInt),
      pB: argument.pB.map((row) => row.map(BigInt)),
      pC: argument.pC.map(BigInt),
    };
    if (this.runtime.family === "evm") {
      const data = new Interface(GRAVARC_WITHDRAW_ABI).encodeFunctionData("withdraw", [value]);
      const request = await this.runtime.wallet.populateTransaction({
        to: this.chain.gravArc,
        data,
        gasLimit: 3_000_000n,
      });
      const raw = await this.runtime.wallet.signTransaction(request);
      return { purpose: "withdraw", family: "evm", hash: keccak256(raw), raw };
    }
    const tupleType = "(uint256[2],uint256[2][2],uint256[2],bytes32,address,uint256,address,uint8,uint256,uint256,uint256,address,uint256)";
    const tupleValue = [
      value.pA, value.pB, value.pC, value.nullifierHash, value.recipient,
      value.claimedAmount, value.token, value.tier, value.depositRoot,
      value.expectedAmount, value.fee, value.relayer, value.nonce,
    ];
    const raw = await this.signTron(
      tronBase58FromCanonical(this.chain.gravArc),
      `withdraw(${tupleType})`,
      [{ type: tupleType, value: tupleValue }],
    );
    const hash = String((raw as Record<string, unknown>).txID ?? "");
    return { purpose: "withdraw", family: "tron", hash, raw };
  }

  async signRefund(argument: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
    depositRoot: bigint;
    nullifierHash: `0x${string}`[];
    token: string;
    refundAmount: bigint;
    fee: bigint;
    relayer: string;
    refunder: string;
    tier: number;
  }): Promise<StoredSignedTransaction> {
    const value = {
      ...argument,
      pA: argument.pA.map(BigInt),
      pB: argument.pB.map((row) => row.map(BigInt)),
      pC: argument.pC.map(BigInt),
    };
    if (this.runtime.family === "evm") {
      const data = new Interface(GRAVARC_REFUND_ABI).encodeFunctionData("refund", [value]);
      const request = await this.runtime.wallet.populateTransaction({
        to: this.chain.gravArc,
        data,
        gasLimit: 4_000_000n,
      });
      const raw = await this.runtime.wallet.signTransaction(request);
      return { purpose: "refund", family: "evm", hash: keccak256(raw), raw };
    }
    const tupleType = "(uint256[2],uint256[2][2],uint256[2],uint256,bytes32[],address,uint256,uint256,address,address,uint8)";
    const tupleValue = [
      value.pA, value.pB, value.pC, value.depositRoot, value.nullifierHash,
      value.token, value.refundAmount, value.fee, value.relayer, value.refunder, value.tier,
    ];
    const raw = await this.signTron(
      tronBase58FromCanonical(this.chain.gravArc),
      `refund(${tupleType})`,
      [{ type: tupleType, value: tupleValue }],
    );
    const hash = String((raw as Record<string, unknown>).txID ?? "");
    return { purpose: "refund", family: "tron", hash, raw };
  }

  async broadcast(transaction: StoredSignedTransaction): Promise<void> {
    if (this.runtime.family === "evm") {
      if (typeof transaction.raw !== "string") throw new Error("Invalid signed EVM transaction");
      const response = await this.runtime.provider.broadcastTransaction(transaction.raw);
      if (response.hash.toLowerCase() !== transaction.hash.toLowerCase()) throw new Error("Broadcast transaction hash mismatch");
      return;
    }
    if (typeof transaction.raw === "string") throw new Error("Invalid signed TRON transaction");
    const response = await this.runtime.tronWeb.trx.sendRawTransaction(
      transaction.raw as unknown as Parameters<typeof this.runtime.tronWeb.trx.sendRawTransaction>[0],
    );
    if (!response.result) throw tronError(response.message, `TRON broadcast failed: ${response.code ?? "unknown"}`);
  }

  async receipt(hash: string, timeoutMs = 120_000): Promise<DepositReceipt | null> {
    if (this.runtime.family === "evm") {
      const receipt = await this.runtime.provider.waitForTransaction(hash, 1, timeoutMs);
      if (!receipt) return null;
      if (receipt.status !== 1) throw new ChainTransactionFailedError(hash, `Transaction failed: ${hash}`);
      return {
        hash,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({ data: log.data, topics: [...log.topics] })),
      };
    }
    const txId = hash.replace(/^0x/, "");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.runtime.tronWeb.trx.getTransactionInfo(txId);
      if (info && Object.keys(info).length > 0) {
        if (info.result === "FAILED" || info.receipt?.result === "OUT_OF_ENERGY") {
          const reason = tronError(info.resMessage, info.receipt?.result ?? "TRON transaction failed");
          throw new ChainTransactionFailedError(hash, reason.message);
        }
        return {
          hash: txId,
          blockNumber: info.blockNumber ?? 0,
          logs: (info.log ?? []).map((log) => ({
            data: `0x${log.data ?? ""}`,
            topics: (log.topics ?? []).map((topic) => `0x${topic.replace(/^0x/, "")}`),
          })),
        };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
    }
    return null;
  }

  depositLeafIndex(receipt: DepositReceipt, predicted: number): number {
    const iface = new Interface(GRAVARC_DEPOSIT_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ data: log.data, topics: log.topics });
        if (parsed?.name === "Deposit") return Number(parsed.args.leafIndex);
      } catch { /* unrelated log */ }
    }
    return predicted;
  }
}
