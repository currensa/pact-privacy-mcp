import { Interface } from "ethers";
import { normalizeAddress } from "../chain/address.js";
import { GRAVARC_REFUND_ABI } from "../deposit/abi.js";
import { OperationLease } from "../operations/lease.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord } from "../operations/types.js";
import { RelayerClient, RelayerHttpError, type RelayerOperation } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptRefund } from "../refund/content.js";
import { RefundProofService } from "../refund/proof.js";
import { refundState } from "../refund/state.js";
import { RelayedRefundPayloadStore } from "./payload-store.js";
import type { RelayedRefundPlan } from "./types.js";

const iface = new Interface(GRAVARC_REFUND_ABI);

function planFrom(operation: OperationRecord): RelayedRefundPlan {
  if (operation.kind !== "relayed-refund") throw new Error(`Operation ${operation.id} is not a relayed refund`);
  const plan = operation.plan as Partial<RelayedRefundPlan>;
  if (
    !Number.isSafeInteger(plan.leafIndex)
    || typeof plan.token !== "string"
    || typeof plan.depositLeaf !== "string"
    || typeof plan.totalAllocated !== "string"
    || typeof plan.refundAmount !== "string"
    || typeof plan.fee !== "string"
    || typeof plan.refunder !== "string"
    || typeof plan.relayer !== "string"
    || typeof plan.relayerUrl !== "string"
    || typeof plan.quoteId !== "string"
    || typeof plan.quoteExpiresAt !== "string"
  ) throw new Error("Relayed refund operation plan is invalid");
  return plan as RelayedRefundPlan;
}

export function encodeRelayedRefundCalldata(result: Awaited<ReturnType<RefundProofService["generate"]>>): string {
  return iface.encodeFunctionData("refund", [{
    pA: result.proof.pA.map(BigInt),
    pB: result.proof.pB.map((row) => row.map(BigInt)),
    pC: result.proof.pC.map(BigInt),
    depositRoot: result.depositRoot,
    nullifierHash: result.nullifierHashes,
    token: result.token,
    refundAmount: result.refundAmount,
    fee: result.fee,
    relayer: result.relayer,
    refunder: result.refunder,
    tier: result.tier,
  }]);
}

export class RelayedRefundExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new RelayedRefundPayloadStore(operations.directory),
    private readonly lease = new OperationLease(operations.directory),
  ) {}

  execute(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.executeLocked(operationId));
  }

  status(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.statusLocked(operationId));
  }

  private async finishIndexing(operationId: string, plan: RelayedRefundPlan): Promise<OperationRecord> {
    const operation = await this.operations.get(operationId);
    if (operation.stage !== "indexing") return operation;
    await this.client.backend.markDepositionRefunded(operation.chainId, plan.leafIndex);
    return this.operations.transition(operationId, "completed", ["indexing"]);
  }

  private async track(operationId: string, remote: RelayerOperation, plan: RelayedRefundPlan): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    if (remote.chainId !== operation.chainId) throw new Error("Relayer operation belongs to a different chain");
    if (remote.operation !== undefined && remote.operation !== "refund") throw new Error("Relayer returned a different operation type");
    const hash = remote.transactionHash;
    if (hash) {
      const tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
      if (!tracked) operation = await this.operations.registerTransaction(operationId, "relayed-refund", hash);
      const current = operation.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
      if (current?.state === "registered") operation = await this.operations.markBroadcast(operationId, hash);
    }
    if (remote.state === "failed") {
      if (hash && operation.transactions.some((entry) => entry.hash.toLowerCase() === hash.toLowerCase())) {
        return this.operations.recordTransactionStatus(operationId, hash, {
          state: "failed",
          error: remote.error?.message ?? remote.error?.code ?? "Relayer operation failed",
        });
      }
      if (operation.stage === "failed") return operation;
      return this.operations.fail(operationId, remote.error?.message ?? remote.error?.code ?? "Relayer operation failed");
    }
    if (remote.state === "confirmed") {
      if (!hash) throw new Error("Confirmed relayer operation has no transaction hash");
      operation = await this.operations.recordTransactionStatus(operationId, hash, {
        state: "confirmed",
        ...(remote.blockNumber !== null ? { blockNumber: remote.blockNumber } : {}),
      });
      if (operation.stage === "pending" || operation.stage === "broadcasting") {
        operation = await this.operations.transition(operationId, "indexing", [operation.stage]);
      }
      return this.finishIndexing(operationId, plan);
    }
    return operation;
  }

  private async statusLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    await this.client.assertRelayedSupported(operation.chainId);
    const plan = planFrom(operation);
    if (operation.stage === "indexing") return this.finishIndexing(operationId, plan);
    if (operation.stage === "completed" || operation.stage === "cancelled" || operation.stage === "expired" || operation.stage === "failed") return operation;
    const payload = await this.payloads.get(operationId);
    if (!payload.relayerOperationId) return operation;
    if (operation.stage === "proving") operation = await this.operations.transition(operationId, "pending", ["proving"]);
    const remote = await new RelayerClient(plan.relayerUrl).operation(payload.relayerOperationId);
    return this.track(operationId, remote, plan);
  }

  private async executeLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    await this.client.assertRelayedSupported(operation.chainId);
    const plan = planFrom(operation);
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(operationId, "relayed-refund", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(operationId);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "indexing") return this.finishIndexing(operationId, plan);
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);
    const payload = await this.payloads.get(operationId);
    if (payload.relayerOperationId) return this.statusLocked(operationId);
    // Exact resubmission can recover an accepted request after an ambiguous
    // HTTP timeout even if the short-lived quote has since expired.
    if (payload.calldata) return this.submit(operationId, plan, payload.calldata);
    if (Date.parse(plan.quoteExpiresAt) <= Date.now()) {
      await this.operations.transition(operationId, "expired", [operation.stage]);
      throw new Error("Relayer quote expired; prepare a new relayed refund");
    }
    if (operation.transactions.length > 0) throw new Error("Relayed refund has a transaction but no relayer operation ID; refusing replacement");
    if (operation.stage !== "proving") throw new Error(`Relayed refund cannot generate a proof from stage ${operation.stage}`);
    const selected = await this.client.chain(operation.chainId);
    if (normalizeAddress(selected.config.gravArc, selected.config.family) !== plan.gravArc) {
      throw new Error("GravArc configuration changed after preparation");
    }
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt refund data");
    const { content, rawSecret } = await decryptRefund(this.client, operation.chainId, plan.leafIndex, password);
    const token = normalizeAddress(content.token, selected.config.family);
    const totalAllocated = content.refundEntries.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    if (
      token !== plan.token
      || content.tier !== plan.tier
      || content.depositLeaf !== plan.depositLeaf
      || totalAllocated.toString() !== plan.totalAllocated
    ) throw new Error("Encrypted refund data no longer matches the prepared relayed refund");
    const state = await refundState(new Web3Service(selected.config, selected.runtime), content);
    if (state.refundAmount.toString() !== plan.refundAmount) {
      throw new Error("Refundable amount changed after the quote; prepare a new relayed refund");
    }
    const result = await new RefundProofService(this.client.backend, this.client.proofs).generate({
      chainId: operation.chainId,
      leafIndex: plan.leafIndex,
      content,
      rawSecret,
      totalClaimed: state.totalClaimed,
      refundAmount: state.refundAmount,
      fee: BigInt(plan.fee),
      relayer: plan.relayer,
      refunder: plan.refunder,
    });
    const calldata = encodeRelayedRefundCalldata(result);
    await this.payloads.saveCalldata(operationId, calldata);
    return this.submit(operationId, plan, calldata);
  }

  private async submit(operationId: string, plan: RelayedRefundPlan, calldata: string): Promise<OperationRecord> {
    const client = new RelayerClient(plan.relayerUrl);
    let remote: RelayerOperation;
    try {
      remote = await client.submitRefund({
        chainId: (await this.operations.get(operationId)).chainId,
        quoteId: plan.quoteId,
        calldata,
      });
    } catch (error) {
      if (error instanceof RelayerHttpError && error.code === "QUOTE_EXPIRED") {
        const operation = await this.operations.get(operationId);
        await this.operations.transition(operationId, "expired", [operation.stage]);
      }
      throw error;
    }
    await this.payloads.saveRelayerOperation(operationId, remote.id);
    const operation = await this.operations.get(operationId);
    if (operation.stage === "proving") await this.operations.transition(operationId, "pending", ["proving"]);
    return this.track(operationId, remote, plan);
  }
}
