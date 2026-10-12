import { ChainTransactionFailedError, DepositChainGateway, type DepositReceipt } from "../deposit/chain.js";
import { DepositPayloadStore, type StoredSignedTransaction } from "../deposit/payload-store.js";
import { OperationLease } from "../operations/lease.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord } from "../operations/types.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { buildDefiCalldata, defiPlanFrom } from "./build.js";
import { deliverRedeposit, enterIndexing } from "./delivery.js";

export class DefiExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new DepositPayloadStore(operations.directory),
    private readonly lease = new OperationLease(operations.directory),
    private readonly chainLease = new OperationLease(),
  ) {}

  execute(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, async () => {
      const operation = await this.operations.get(operationId);
      return this.chainLease.runResource(`deposit-chain-${operation.chainId}`, () => this.executeLocked(operationId));
    });
  }

  private async submit(operationId: string, transaction: StoredSignedTransaction, gateway: DepositChainGateway): Promise<DepositReceipt> {
    let operation = await this.operations.get(operationId);
    let tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    if (!tracked) {
      operation = await this.operations.registerTransaction(operationId, "defi", transaction.hash);
      tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    }
    if (!tracked) throw new Error("Signed DeFi transaction could not be registered");
    if (tracked.state === "failed") throw new Error(`DeFi transaction already failed: ${transaction.hash}`);
    if (tracked.state === "registered") {
      await this.operations.markBroadcast(operationId, transaction.hash);
      await gateway.broadcast(transaction);
    }
    try {
      const receipt = await gateway.receipt(transaction.hash, 240_000);
      if (!receipt) throw new Error(`DeFi transaction is still pending: ${transaction.hash}`);
      await this.operations.recordTransactionStatus(operationId, transaction.hash, { state: "confirmed", blockNumber: receipt.blockNumber });
      return receipt;
    } catch (error) {
      if (error instanceof ChainTransactionFailedError) {
        await this.operations.recordTransactionStatus(operationId, transaction.hash, { state: "failed", error: error.message });
      }
      throw error;
    }
  }

  private async executeLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    const plan = defiPlanFrom(operation, "defi");
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(operationId, "defi", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(operationId);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);
    const selected = await this.client.chain(operation.chainId);
    if (!selected.config.pactPrivacyDefiRouter) throw new Error("DeFi router is not configured");
    const gateway = new DepositChainGateway(selected.config, selected.runtime, this.client.signer.privateKey);
    let payload = await this.payloads.get(operationId);
    let transaction = payload.transactions.find((entry) => entry.purpose === "defi");
    if (!transaction) {
      if (operation.transactions.length > 0) throw new Error("DeFi has a registered transaction but its signed payload is unavailable; refusing replacement");
      if (operation.stage !== "proving") throw new Error(`DeFi cannot generate a proof from stage ${operation.stage}`);
      const built = await buildDefiCalldata(this.client, operation, plan);
      if (built.delivery) await this.payloads.saveDelivery(operationId, built.delivery);
      transaction = await gateway.signDefi(selected.config.pactPrivacyDefiRouter, built.calldata);
      await this.payloads.saveTransaction(operationId, transaction);
      await this.operations.registerTransaction(operationId, "defi", transaction.hash);
      payload = await this.payloads.get(operationId);
    }
    const receipt = await this.submit(operationId, transaction, gateway);
    if (!plan.privateRedeposit) {
      const current = await this.operations.get(operationId);
      return current.stage === "pending" || current.stage === "broadcasting"
        ? this.operations.transition(operationId, "completed", [current.stage]) : current;
    }
    if (!payload.delivery) throw new Error("Encrypted re-deposit delivery payload is unavailable");
    operation = await enterIndexing(this.operations, operationId);
    const leafIndex = gateway.depositLeafIndex(receipt, payload.delivery.predictedLeafIndex);
    if (operation.stage !== "completed") await deliverRedeposit(this.client, this.operations, operation, payload.delivery, leafIndex, receipt.hash);
    return this.operations.get(operationId);
  }
}
