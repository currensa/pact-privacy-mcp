import { normalizeAddress } from "../chain/address.js";
import { ChainTransactionFailedError, DepositChainGateway } from "../deposit/chain.js";
import type { StoredSignedTransaction } from "../deposit/payload-store.js";
import { OperationLease } from "../operations/lease.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord, OperationStage } from "../operations/types.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptRefund } from "./content.js";
import { RefundPayloadStore } from "./payload-store.js";
import { RefundProofService } from "./proof.js";
import { refundState } from "./state.js";
import type { RefundPlan } from "./types.js";

function planFrom(operation: OperationRecord): RefundPlan {
  if (operation.kind !== "refund") throw new Error(`Operation ${operation.id} is not a refund`);
  const plan = operation.plan as Partial<RefundPlan>;
  if (
    !Number.isSafeInteger(plan.leafIndex)
    || typeof plan.token !== "string"
    || typeof plan.depositLeaf !== "string"
    || typeof plan.totalAllocated !== "string"
    || typeof plan.refunder !== "string"
    || typeof plan.relayer !== "string"
  ) throw new Error("Refund operation plan is invalid");
  return plan as RefundPlan;
}

export class RefundExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new RefundPayloadStore(operations.directory),
    private readonly lease = new OperationLease(operations.directory),
  ) {}

  private async submitAndConfirm(operationId: string, transaction: StoredSignedTransaction, gateway: DepositChainGateway) {
    let operation = await this.operations.get(operationId);
    let tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    if (!tracked) {
      operation = await this.operations.registerTransaction(operationId, "refund", transaction.hash);
      tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    }
    if (!tracked) throw new Error("Signed refund transaction could not be registered");
    if (tracked.state === "failed") throw new Error(`Refund transaction already failed: ${transaction.hash}`);
    if (tracked.state === "registered") {
      await this.operations.markBroadcast(operationId, transaction.hash);
      await gateway.broadcast(transaction);
    }
    if (tracked.state !== "confirmed") {
      try {
        const receipt = await gateway.receipt(transaction.hash, 180_000);
        if (!receipt) throw new Error(`Refund transaction is still pending: ${transaction.hash}`);
        await this.operations.recordTransactionStatus(operationId, transaction.hash, {
          state: "confirmed",
          blockNumber: receipt.blockNumber,
        });
      } catch (error) {
        if (error instanceof ChainTransactionFailedError) {
          await this.operations.recordTransactionStatus(operationId, transaction.hash, { state: "failed", error: error.message });
        }
        throw error;
      }
    }
    const current = await this.operations.get(operationId);
    if (current.stage === "pending" || current.stage === "broadcasting") {
      return this.operations.transition(operationId, "indexing", [current.stage]);
    }
    return current;
  }

  execute(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.executeLocked(operationId));
  }

  private async executeLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    const plan = planFrom(operation);
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(operationId, "refund", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(operationId);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);

    const selected = await this.client.chain(operation.chainId);
    const gateway = new DepositChainGateway(selected.config, selected.runtime, this.client.signer.privateKey);
    const stored = (await this.payloads.get(operationId)).transaction;
    if (stored) operation = await this.submitAndConfirm(operationId, stored, gateway);
    else {
      if (operation.transactions.length > 0) {
        throw new Error("Refund has a registered transaction but its signed payload is unavailable; refusing replacement");
      }
      if (operation.stage !== "proving") throw new Error(`Refund cannot generate a proof from stage ${operation.stage}`);
      const password = this.client.environment.password;
      if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt refund data");
      const { content, rawSecret } = await decryptRefund(
        this.client, operation.chainId, plan.leafIndex, password,
      );
      const token = normalizeAddress(content.token, selected.config.family);
      const signer = normalizeAddress(this.client.signer.address(selected.config.family), selected.config.family);
      if (
        token !== plan.token
        || content.tier !== plan.tier
        || content.depositLeaf !== plan.depositLeaf
        || content.refundEntries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n).toString() !== plan.totalAllocated
      ) throw new Error("Encrypted refund data no longer matches the prepared operation");
      if (signer !== plan.refunder || signer !== plan.relayer) throw new Error("Prepared refund is for a different local signer");
      const state = await refundState(new Web3Service(selected.config, selected.runtime), content);
      const result = await new RefundProofService(this.client.backend, this.client.proofs).generate({
        chainId: operation.chainId,
        leafIndex: plan.leafIndex,
        content,
        rawSecret,
        totalClaimed: state.totalClaimed,
        refundAmount: state.refundAmount,
        fee: state.fee,
        relayer: plan.relayer,
        refunder: plan.refunder,
      });
      const transaction = await gateway.signRefund({
        pA: result.proof.pA,
        pB: result.proof.pB,
        pC: result.proof.pC,
        depositRoot: result.depositRoot,
        nullifierHash: result.nullifierHashes,
        token: result.token,
        refundAmount: result.refundAmount,
        fee: result.fee,
        relayer: result.relayer,
        refunder: result.refunder,
        tier: result.tier,
      });
      await this.payloads.saveTransaction(operationId, transaction);
      await this.operations.registerTransaction(operationId, "refund", transaction.hash);
      operation = await this.submitAndConfirm(operationId, transaction, gateway);
    }
    if (operation.stage !== "indexing" && operation.stage !== "completed") {
      throw new Error(`Refund cannot update the backend from stage ${operation.stage}`);
    }
    if (operation.stage === "indexing") {
      await this.client.backend.markDepositionRefunded(operation.chainId, plan.leafIndex);
      operation = await this.operations.transition(operationId, "completed", ["indexing" as OperationStage]);
    }
    return operation;
  }
}
