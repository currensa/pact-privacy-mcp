import { normalizeAddress } from "../chain/address.js";
import { buildDefiCalldata, defiPlanFrom } from "../defi/build.js";
import { deliverRedeposit, enterIndexing } from "../defi/delivery.js";
import type { RelayedDefiPlan } from "../defi/types.js";
import { OperationLease } from "../operations/lease.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord } from "../operations/types.js";
import { RelayerClient, RelayerHttpError, type RelayerOperation } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { RelayedDefiPayloadStore } from "./payload-store.js";

function planFrom(operation: OperationRecord): RelayedDefiPlan {
  const base = defiPlanFrom(operation, "relayed-defi") as RelayedDefiPlan;
  if (typeof base.relayerUrl !== "string" || typeof base.quoteId !== "string" || typeof base.quoteExpiresAt !== "string"
    || typeof base.relayer !== "string" || typeof base.defiRouter !== "string") throw new Error("Relayed DeFi operation plan is invalid");
  return base;
}

export class RelayedDefiExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new RelayedDefiPayloadStore(operations.directory),
    private readonly lease = new OperationLease(operations.directory),
    private readonly chainLease = new OperationLease(),
  ) {}

  execute(id: string): Promise<OperationRecord> { return this.lease.run(id, () => this.executeLocked(id)); }
  status(id: string): Promise<OperationRecord> { return this.lease.run(id, () => this.statusLocked(id)); }

  private async finishDelivery(id: string, plan: RelayedDefiPlan): Promise<OperationRecord> {
    const operation = await this.operations.get(id);
    if (operation.stage !== "indexing" && operation.stage !== "delivering") return operation;
    if (!plan.privateRedeposit) throw new Error("Public relayed DeFi cannot have pending encrypted delivery");
    const confirmed = operation.transactions.find((entry) =>
      entry.state === "confirmed" && entry.purpose === "relayed-defi");
    if (!confirmed) throw new Error("Confirmed relayed DeFi transaction is unavailable");
    const payload = await this.payloads.get(id);
    if (!payload.delivery) throw new Error("Encrypted re-deposit delivery payload is unavailable");
    await deliverRedeposit(
      this.client, this.operations, operation, payload.delivery,
      payload.delivery.predictedLeafIndex, confirmed.hash,
    );
    return this.operations.get(id);
  }

  private async track(id: string, remote: RelayerOperation): Promise<OperationRecord> {
    let operation = await this.operations.get(id);
    const plan = planFrom(operation);
    if (remote.operation !== undefined && remote.operation !== "defi") throw new Error("Relayer returned a non-DeFi operation");
    if (remote.chainId !== operation.chainId) throw new Error("Relayer operation belongs to a different chain");
    const hash = remote.transactionHash;
    if (hash) {
      if (!operation.transactions.some((entry) => entry.hash.toLowerCase() === hash.toLowerCase())) {
        operation = await this.operations.registerTransaction(id, "relayed-defi", hash);
      }
      const tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
      if (tracked?.state === "registered") operation = await this.operations.markBroadcast(id, hash);
    }
    if (remote.state === "failed") {
      if (hash && operation.transactions.some((entry) => entry.hash.toLowerCase() === hash.toLowerCase())) {
        return this.operations.recordTransactionStatus(id, hash, { state: "failed", error: remote.error?.message ?? remote.error?.code ?? "Relayer operation failed" });
      }
      return operation.stage === "failed" ? operation : this.operations.fail(id, remote.error?.message ?? remote.error?.code ?? "Relayer operation failed");
    }
    if (remote.state !== "confirmed") return this.operations.get(id);
    if (!hash) throw new Error("Confirmed relayer operation has no transaction hash");
    operation = await this.operations.recordTransactionStatus(id, hash, { state: "confirmed", ...(remote.blockNumber !== null ? { blockNumber: remote.blockNumber } : {}) });
    if (!plan.privateRedeposit) {
      return operation.stage === "pending" || operation.stage === "broadcasting"
        ? this.operations.transition(id, "completed", [operation.stage]) : operation;
    }
    const payload = await this.payloads.get(id);
    if (!payload.delivery) throw new Error("Encrypted re-deposit delivery payload is unavailable");
    if (remote.blockNumber === null) throw new Error("Confirmed relayer operation has no block number");
    operation = await enterIndexing(this.operations, id);
    if (operation.stage !== "completed") {
      return this.finishDelivery(id, plan);
    }
    return this.operations.get(id);
  }

  private async statusLocked(id: string): Promise<OperationRecord> {
    let operation = await this.operations.get(id);
    await this.client.assertAccount(operation.chainId);
    const plan = planFrom(operation);
    if (operation.stage === "indexing" || operation.stage === "delivering") return this.finishDelivery(id, plan);
    if (["completed", "cancelled", "expired", "failed"].includes(operation.stage)) return operation;
    const payload = await this.payloads.get(id);
    if (!payload.relayerOperationId) return operation;
    if (operation.stage === "proving") operation = await this.operations.transition(id, "pending", ["proving"]);
    return this.track(id, await new RelayerClient(plan.relayerUrl).operation(payload.relayerOperationId));
  }

  private async executeLocked(id: string): Promise<OperationRecord> {
    let operation = await this.operations.get(id);
    await this.client.assertAccount(operation.chainId);
    const plan = planFrom(operation);
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(id, "relayed-defi", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(id);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "indexing" || operation.stage === "delivering") return this.finishDelivery(id, plan);
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);
    const payload = await this.payloads.get(id);
    if (payload.relayerOperationId) return this.statusLocked(id);
    if (payload.calldata) return this.submit(id, plan, payload.calldata);
    if (Date.parse(plan.quoteExpiresAt) <= Date.now()) {
      await this.operations.transition(id, "expired", [operation.stage]);
      throw new Error("Relayer quote expired; prepare a new relayed DeFi operation");
    }
    if (operation.transactions.length > 0) throw new Error("Relayed DeFi has a transaction but no relayer operation ID; refusing replacement");
    const selected = await this.client.chain(operation.chainId);
    if (!selected.config.pactPrivacyDefiRouter
      || normalizeAddress(selected.config.pactPrivacyDefiRouter, selected.config.family) !== plan.defiRouter) {
      throw new Error("DeFi router configuration changed after preparation");
    }
    const built = await this.chainLease.runResource(`deposit-chain-${operation.chainId}`, () => buildDefiCalldata(this.client, operation, plan));
    await this.payloads.saveCalldata(id, built.calldata, built.delivery);
    return this.submit(id, plan, built.calldata);
  }

  private async submit(id: string, plan: RelayedDefiPlan, calldata: string): Promise<OperationRecord> {
    let remote: RelayerOperation;
    try { remote = await new RelayerClient(plan.relayerUrl).submitDefi({ chainId: (await this.operations.get(id)).chainId, quoteId: plan.quoteId, calldata }); }
    catch (error) {
      if (error instanceof RelayerHttpError && error.code === "QUOTE_EXPIRED") {
        const operation = await this.operations.get(id); await this.operations.transition(id, "expired", [operation.stage]);
      }
      throw error;
    }
    await this.payloads.saveRelayerOperation(id, remote.id);
    const operation = await this.operations.get(id);
    if (operation.stage === "proving") await this.operations.transition(id, "pending", ["proving"]);
    return this.track(id, remote);
  }
}
