import { normalizeAddress } from "../chain/address.js";
import { DepositChainGateway, ChainTransactionFailedError } from "../deposit/chain.js";
import type { StoredSignedTransaction } from "../deposit/payload-store.js";
import { OperationLease } from "../operations/lease.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord } from "../operations/types.js";
import { poseidonHash } from "../proof/poseidon.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptAllocation } from "./allocation.js";
import { WithdrawPayloadStore } from "./payload-store.js";
import { WithdrawProofService } from "./proof.js";
import type { WithdrawPlan } from "./types.js";

function planFrom(operation: OperationRecord): WithdrawPlan {
  if (operation.kind !== "withdraw") throw new Error(`Operation ${operation.id} is not a withdrawal`);
  const plan = operation.plan as Partial<WithdrawPlan>;
  if (
    typeof plan.allocationId !== "string" || !plan.allocationId
    || (plan.source !== "payroll" && plan.source !== "defi")
    || !Number.isSafeInteger(plan.leafIndex)
    || typeof plan.token !== "string"
    || typeof plan.expectedAmount !== "string"
    || typeof plan.fee !== "string"
    || typeof plan.recipient !== "string"
    || typeof plan.relayer !== "string"
  ) throw new Error("Withdrawal operation plan is invalid");
  return plan as WithdrawPlan;
}

export class WithdrawExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new WithdrawPayloadStore(operations.directory),
    private readonly lease = new OperationLease(operations.directory),
  ) {}

  private async submitAndConfirm(operationId: string, plan: WithdrawPlan, transaction: StoredSignedTransaction, gateway: DepositChainGateway) {
    let operation = await this.operations.get(operationId);
    let tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    if (!tracked) {
      operation = await this.operations.registerTransaction(operationId, "withdraw", transaction.hash);
      tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    }
    if (!tracked) throw new Error("Signed withdrawal transaction could not be registered");
    if (tracked.state === "failed") throw new Error(`Withdrawal transaction already failed: ${transaction.hash}`);
    if (tracked.state === "registered") {
      await this.operations.markBroadcast(operationId, transaction.hash);
      await gateway.broadcast(transaction);
    }
    try {
      const receipt = await gateway.receipt(transaction.hash, 180_000);
      if (!receipt) throw new Error(`Withdrawal transaction is still pending: ${transaction.hash}`);
      await this.operations.recordTransactionStatus(operationId, transaction.hash, {
        state: "confirmed",
        blockNumber: receipt.blockNumber,
      });
      const current = await this.operations.get(operationId);
      if (current.stage === "pending" || current.stage === "broadcasting") {
        operation = await this.operations.transition(operationId, "indexing", [current.stage]);
      } else operation = current;
      if (plan.source === "payroll") {
        await this.client.backend.confirmPrivacyWithdraw(plan.allocationId, transaction.hash);
      }
      if (operation.stage === "indexing") return this.operations.transition(operationId, "completed", ["indexing"]);
      return operation;
    } catch (error) {
      if (error instanceof ChainTransactionFailedError) {
        await this.operations.recordTransactionStatus(operationId, transaction.hash, { state: "failed", error: error.message });
      }
      throw error;
    }
  }

  execute(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.executeLocked(operationId));
  }

  private async executeLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    const plan = planFrom(operation);
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(operationId, "withdraw", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(operationId);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);
    const selected = await this.client.chain(operation.chainId);
    const gateway = new DepositChainGateway(selected.config, selected.runtime, this.client.signer.privateKey);
    const stored = (await this.payloads.get(operationId)).transaction;
    if (stored) return this.submitAndConfirm(operationId, plan, stored, gateway);
    if (operation.transactions.length > 0) {
      throw new Error("Withdrawal has a registered transaction but its signed payload is unavailable; refusing replacement");
    }
    if (operation.stage !== "proving") throw new Error(`Withdrawal cannot generate a proof from stage ${operation.stage}`);
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt the allocation");
    const { info, rawSecret, source } = await decryptAllocation(this.client, operation.chainId, plan.allocationId, password);
    const token = normalizeAddress(info.token, selected.config.family);
    if (
      info.leafIndex !== plan.leafIndex
      || info.tier !== plan.tier
      || info.amount !== plan.allocationAmount
      || source !== plan.source
      || token !== plan.token
    ) throw new Error("Encrypted allocation no longer matches the prepared withdrawal");
    const localAddress = normalizeAddress(this.client.signer.address(selected.config.family), selected.config.family);
    if (localAddress !== plan.relayer) throw new Error("Prepared withdrawal fee recipient is a different local signer");
    const nullifierHashValue = await poseidonHash([BigInt(info.nullifier)]);
    const state = await new Web3Service(selected.config, selected.runtime).claimedState(
      `0x${nullifierHashValue.toString(16).padStart(64, "0")}`,
    );
    if (state.refunded) throw new Error("This allocation was refunded");
    const expectedAmount = BigInt(plan.expectedAmount);
    if (state.claimed + expectedAmount > BigInt(info.amount)) throw new Error("The prepared amount exceeds the current remaining allocation");
    const result = await new WithdrawProofService(this.client.backend, this.client.proofs).generate({
      chainId: operation.chainId,
      info,
      rawSecret,
      recipient: plan.recipient,
      relayer: plan.relayer,
      claimedAmount: state.claimed,
      nonce: state.nonce,
      expectedAmount,
      fee: BigInt(plan.fee),
    });
    const transaction = await gateway.signWithdraw({
      pA: result.proof.pA,
      pB: result.proof.pB,
      pC: result.proof.pC,
      nullifierHash: result.nullifierHash,
      recipient: result.recipient,
      claimedAmount: result.claimedAmount,
      token: result.token,
      tier: result.tier,
      depositRoot: result.depositRoot,
      expectedAmount: result.expectedAmount,
      fee: result.fee,
      relayer: result.relayer,
      nonce: result.nonce,
    });
    await this.payloads.saveTransaction(operationId, transaction);
    await this.operations.registerTransaction(operationId, "withdraw", transaction.hash);
    return this.submitAndConfirm(operationId, plan, transaction, gateway);
  }
}
