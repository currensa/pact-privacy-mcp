import { normalizeAddress } from "../chain/address.js";
import type { RegisteredReceiver } from "../core/types.js";
import { encryptMessage } from "../crypto/messages.js";
import { BackendError } from "../backend/client.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord, OperationStage } from "../operations/types.js";
import { OperationLease } from "../operations/lease.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { ChainTransactionFailedError, DepositChainGateway, type DepositReceipt } from "./chain.js";
import { DepositPayloadStore, type DepositDelivery, type StoredSignedTransaction } from "./payload-store.js";
import { DepositProofService } from "./proof.js";
import { depositRegistryDigest } from "./prepare.js";
import type { DepositPlan, DepositReceiver } from "./types.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function planFrom(operation: OperationRecord): DepositPlan {
  if (operation.kind !== "deposit") throw new Error(`Operation ${operation.id} is not a deposit`);
  const plan = operation.plan as Partial<DepositPlan>;
  if (
    typeof plan.token !== "string"
    || typeof plan.tokenSymbol !== "string"
    || !Number.isSafeInteger(plan.decimals)
    || typeof plan.native !== "boolean"
    || !Array.isArray(plan.recipients)
    || typeof plan.registryDigest !== "string"
    || typeof plan.totalAmount !== "string"
    || typeof plan.refund !== "boolean"
    || !plan.allowance
  ) throw new Error("Deposit operation plan is invalid");
  return plan as DepositPlan;
}

function registeredReceiver(row: RegisteredReceiver, family: "evm" | "tron") {
  if (!/^0x[0-9a-fA-F]{64}$/.test(row.secretHash) || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(row.encPubkey)) {
    throw new Error(`Receiver registration is invalid: ${row.address}`);
  }
  return { ...row, address: normalizeAddress(row.address, family) };
}

export class DepositExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new DepositPayloadStore(),
    private readonly lease = new OperationLease(),
    private readonly chainLease = new OperationLease(),
  ) {}

  private async receivers(operation: OperationRecord, plan: DepositPlan): Promise<{
    receivers: DepositReceiver[];
    depositorSecretHash?: string;
    depositorEncPubkey: string | null;
  }> {
    const { config } = await this.client.chain(operation.chainId);
    const rows = (await this.client.backend.users(config.family)).map((row) => registeredReceiver(row, config.family));
    const receivers = plan.recipients.map((recipient) => {
      const account = rows.find((row) => row.address === recipient.address);
      if (!account) throw new Error(`Receiver is no longer registered: ${recipient.address}`);
      return {
        address: recipient.address,
        amount: BigInt(recipient.amount),
        secretHash: account.secretHash,
        encPubkey: account.encPubkey,
      };
    });
    const registryDigest = depositRegistryDigest(receivers.map((receiver) => ({
      address: receiver.address,
      account: receiver.secretHash,
      key: receiver.encPubkey,
    })));
    if (registryDigest !== plan.registryDigest) throw new Error("Receiver registration changed; prepare a new deposit");

    if (!plan.refund) return { receivers, depositorEncPubkey: null };
    const account = await this.client.backend.account(config.family);
    if (!account.found || !account.secretHash || !account.encPubkey) {
      throw new Error("Depositor account data is unavailable for refund support");
    }
    const digest = depositRegistryDigest({ account: account.secretHash, key: account.encPubkey });
    if (digest !== plan.depositorRegistryDigest) throw new Error("Depositor account data changed; prepare a new deposit");
    return { receivers, depositorSecretHash: account.secretHash, depositorEncPubkey: account.encPubkey };
  }

  private delivery(operation: OperationRecord, plan: DepositPlan, proof: Awaited<ReturnType<DepositProofService["generate"]>>, receivers: DepositReceiver[], depositorEncPubkey: string | null): DepositDelivery {
    const batchId = `dp_${operation.id}`;
    const messages = proof.receivers.map((receiver, index) => ({
      address: receiver.address,
      content: encryptMessage(JSON.stringify({
        nullifier: receiver.nullifier,
        amount: receiver.amount,
        token: plan.token,
        decimals: plan.decimals,
        tokenSymbol: plan.tokenSymbol,
        authRoot: proof.authRoot,
        depositorSecretHash: proof.depositorSecretHash,
        authPathElements: receiver.authPathElements,
        authPathIndices: receiver.authPathIndices,
        leafIndex: proof.leafIndex,
        tier: proof.tier,
      }), receiver.encPubkey),
      secretHash: receivers[index]!.secretHash,
      encPubkey: receivers[index]!.encPubkey,
      clientMessageId: `${batchId}:${index}`,
    }));
    const encContent = proof.canRefund === 1 && depositorEncPubkey
      ? encryptMessage(JSON.stringify({
        token: plan.token,
        tokenSymbol: plan.tokenSymbol,
        decimals: plan.decimals,
        tier: proof.tier,
        authRoot: proof.authRoot,
        depositLeaf: proof.depositLeaf,
        depositorSecretHash: proof.depositorSecretHash,
        refundEntries: proof.refundEntries,
      }), depositorEncPubkey)
      : null;
    return {
      predictedLeafIndex: proof.leafIndex,
      deposition: {
        encContent,
        canRefund: proof.canRefund,
        depositInfo: JSON.stringify({ depositorSecretHash: proof.depositorSecretHash, encPubkey: depositorEncPubkey }),
      },
      messages,
    };
  }

  private async signedTransaction(
    operation: OperationRecord,
    signed: () => Promise<StoredSignedTransaction>,
  ): Promise<StoredSignedTransaction> {
    const payload = await this.payloads.get(operation.id);
    const existing = payload.transactions.find((transaction) => transaction.purpose === (operation.stage === "proving" ? "approval" : "deposit"));
    if (existing) return existing;
    const transaction = await signed();
    await this.payloads.saveTransaction(operation.id, transaction);
    await this.operations.registerTransaction(operation.id, transaction.purpose, transaction.hash);
    return transaction;
  }

  private async submitAndConfirm(operationId: string, transaction: StoredSignedTransaction, gateway: DepositChainGateway): Promise<DepositReceipt> {
    let operation = await this.operations.get(operationId);
    let tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    if (!tracked) {
      operation = await this.operations.registerTransaction(operationId, transaction.purpose, transaction.hash);
      tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    }
    if (!tracked) throw new Error("Signed transaction could not be registered");
    if (tracked.state === "failed") throw new Error(`Transaction already failed: ${transaction.hash}`);
    if (tracked.state === "registered") {
      await this.operations.markBroadcast(operationId, transaction.hash);
      await gateway.broadcast(transaction);
    }
    try {
      const receipt = await gateway.receipt(transaction.hash);
      if (!receipt) throw new Error(`Transaction is still pending: ${transaction.hash}`);
      await this.operations.recordTransactionStatus(operationId, transaction.hash, {
        state: "confirmed",
        blockNumber: receipt.blockNumber,
      });
      return receipt;
    } catch (error) {
      if (error instanceof ChainTransactionFailedError) {
        await this.operations.recordTransactionStatus(operationId, transaction.hash, { state: "failed", error: error.message });
      }
      throw error;
    }
  }

  private async saveBackend(
    operation: OperationRecord,
    delivery: DepositDelivery,
    leafIndex: number,
    blockNumber: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await this.client.backend.saveDeposition({
          leafIndex,
          chainId: operation.chainId,
          blockNumber,
          encContent: delivery.deposition.encContent,
          canRefund: delivery.deposition.canRefund,
          isRefunded: false,
          depositInfo: delivery.deposition.depositInfo,
        });
        break;
      } catch (error) {
        if (!(error instanceof BackendError) || (error.status !== 409 && error.status !== 503) || Date.now() >= deadline) throw error;
        await delay(3_000);
      }
    }
    const current = await this.operations.get(operation.id);
    if (current.stage === "indexing") await this.operations.transition(operation.id, "delivering", ["indexing"]);
    for (const message of delivery.messages) {
      await this.client.backend.saveMessage({ ...message, chainId: operation.chainId, leafIndex });
    }
    const delivered = await this.operations.get(operation.id);
    if (delivered.stage === "delivering") await this.operations.transition(operation.id, "completed", ["delivering"]);
  }

  async execute(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.executeLocked(operationId));
  }

  private async executeLocked(operationId: string): Promise<OperationRecord> {
    const operation = await this.operations.get(operationId);
    return this.chainLease.runResource(
      `deposit-chain-${operation.chainId}`,
      () => this.executeChainLocked(operationId),
    );
  }

  private async executeChainLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    const blocker = conflictingDepositOperation(await this.operations.list(true), operation);
    if (blocker) {
      throw new Error(`Deposit operation ${blocker} must be reconciled before another deposit can execute on chain ${operation.chainId}`);
    }
    const plan = planFrom(operation);
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(operationId, "deposit", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(operationId);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);

    const selected = await this.client.chain(operation.chainId);
    const web3 = new Web3Service(selected.config, selected.runtime);
    const gateway = new DepositChainGateway(selected.config, selected.runtime, this.client.signer.privateKey);
    const payload = await this.payloads.get(operationId);
    const depositTransaction = payload.transactions.find((transaction) => transaction.purpose === "deposit");
    let depositReceipt: DepositReceipt | undefined;

    if (depositTransaction) {
      depositReceipt = await this.submitAndConfirm(operationId, depositTransaction, gateway);
    } else if (operation.stage !== "indexing" && operation.stage !== "delivering") {
      const receiverData = await this.receivers(operation, plan);
      const balance = plan.native ? await web3.nativeBalance() : await web3.tokenBalance(plan.token);
      if (BigInt(balance.raw) < BigInt(plan.totalAmount)) throw new Error(`Insufficient ${plan.tokenSymbol} balance`);

      if (!plan.native) {
        const allowance = await web3.allowance(plan.token, selected.config.gravArc);
        if (BigInt(allowance.raw) < BigInt(plan.totalAmount)) {
          if (!plan.allowance.approvalRequired) throw new Error("Allowance changed; prepare a new deposit to review the approval");
          const existingApproval = (await this.payloads.get(operationId)).transactions.find((transaction) => transaction.purpose === "approval");
          const approval = existingApproval ?? await this.signedTransaction(operation, () => gateway.signApproval(plan.token, BigInt(plan.totalAmount)));
          await this.submitAndConfirm(operationId, approval, gateway);
          operation = await this.operations.transition(operationId, "proving", ["pending", "broadcasting"]);
          const refreshed = await web3.allowance(plan.token, selected.config.gravArc);
          if (BigInt(refreshed.raw) < BigInt(plan.totalAmount)) throw new Error("Token approval did not establish the required allowance");
        }
      }

      const backendPath = await this.client.backend.depositPath(operation.chainId);
      const onChainNextIndex = await web3.depositNextIndex();
      if (backendPath.nextIndex !== onChainNextIndex) {
        throw new Error(`Scanner is out of sync: backend leaf ${backendPath.nextIndex}, chain leaf ${onChainNextIndex}`);
      }
      const proof = await new DepositProofService(this.client.backend, this.client.proofs).generate({
        receivers: receiverData.receivers,
        token: BigInt(plan.token),
        chainId: operation.chainId,
        refund: plan.refund,
        ...(receiverData.depositorSecretHash ? { depositorSecretHash: receiverData.depositorSecretHash } : {}),
      });
      const delivery = this.delivery(operation, plan, proof, receiverData.receivers, receiverData.depositorEncPubkey);
      await this.payloads.saveDelivery(operationId, delivery);
      const transaction = await gateway.signDeposit(plan, proof);
      await this.payloads.saveTransaction(operationId, transaction);
      await this.operations.registerTransaction(operationId, "deposit", transaction.hash);
      depositReceipt = await this.submitAndConfirm(operationId, transaction, gateway);
    }

    const latestPayload = await this.payloads.get(operationId);
    if (!latestPayload.delivery) throw new Error("Encrypted deposit delivery payload is unavailable");
    if (!depositReceipt) {
      const storedDeposit = latestPayload.transactions.find((transaction) => transaction.purpose === "deposit");
      if (!storedDeposit) throw new Error("Deposit transaction is unavailable");
      depositReceipt = await this.submitAndConfirm(operationId, storedDeposit, gateway);
    }
    const leafIndex = gateway.depositLeafIndex(depositReceipt, latestPayload.delivery.predictedLeafIndex);
    operation = await this.operations.get(operationId);
    if (operation.stage === "pending" || operation.stage === "broadcasting") {
      operation = await this.operations.transition(operationId, "indexing", [operation.stage as OperationStage]);
    }
    if (operation.stage !== "indexing" && operation.stage !== "delivering" && operation.stage !== "completed") {
      throw new Error(`Deposit cannot deliver from stage ${operation.stage}`);
    }
    if (operation.stage !== "completed") {
      await this.saveBackend(operation, latestPayload.delivery, leafIndex, depositReceipt.blockNumber, selected.config.family === "tron" ? 180_000 : 90_000);
    }
    return this.operations.get(operationId);
  }
}

export function conflictingDepositOperation(records: OperationRecord[], current: OperationRecord): string | undefined {
  return records.find((record) => {
    if (record.id === current.id || record.kind !== "deposit" || record.chainId !== current.chainId) return false;
    const deposit = record.transactions.find((transaction) => transaction.purpose === "deposit");
    if (!deposit || deposit.state === "failed") return false;
    return record.stage === "broadcasting" || record.stage === "pending" || record.stage === "indexing";
  })?.id;
}
