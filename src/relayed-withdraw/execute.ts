import { Interface } from "ethers";
import { normalizeAddress } from "../chain/address.js";
import { GRAVARC_WITHDRAW_ABI } from "../deposit/abi.js";
import { OperationLease } from "../operations/lease.js";
import { OperationService } from "../operations/service.js";
import type { OperationRecord } from "../operations/types.js";
import { poseidonHash } from "../proof/poseidon.js";
import { RelayerClient, RelayerHttpError, type RelayerOperation } from "../relayer/client.js";
import type { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import { decryptAllocation } from "../withdraw/allocation.js";
import { WithdrawProofService } from "../withdraw/proof.js";
import { RelayedWithdrawPayloadStore } from "./payload-store.js";
import type { RelayedWithdrawPlan } from "./types.js";

const iface = new Interface(GRAVARC_WITHDRAW_ABI);

function planFrom(operation: OperationRecord): RelayedWithdrawPlan {
  if (operation.kind !== "relayed-withdraw") throw new Error(`Operation ${operation.id} is not a relayed withdrawal`);
  const plan = operation.plan as Partial<RelayedWithdrawPlan>;
  if (
    typeof plan.allocationId !== "string" || !plan.allocationId
    || (plan.source !== "payroll" && plan.source !== "defi")
    || !Number.isSafeInteger(plan.leafIndex)
    || typeof plan.token !== "string"
    || typeof plan.expectedAmount !== "string"
    || typeof plan.fee !== "string"
    || typeof plan.recipient !== "string"
    || typeof plan.relayer !== "string"
    || typeof plan.relayerUrl !== "string"
    || typeof plan.quoteId !== "string"
    || typeof plan.quoteExpiresAt !== "string"
  ) throw new Error("Relayed withdrawal operation plan is invalid");
  return plan as RelayedWithdrawPlan;
}

export function encodeRelayedWithdrawCalldata(result: Awaited<ReturnType<WithdrawProofService["generate"]>>): string {
  return iface.encodeFunctionData("withdraw", [{
    pA: result.proof.pA.map(BigInt),
    pB: result.proof.pB.map((row) => row.map(BigInt)),
    pC: result.proof.pC.map(BigInt),
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
  }]);
}

export class RelayedWithdrawExecutionService {
  constructor(
    private readonly client: PactPrivacyClient,
    private readonly operations = new OperationService(),
    private readonly payloads = new RelayedWithdrawPayloadStore(operations.directory),
    private readonly lease = new OperationLease(operations.directory),
  ) {}

  execute(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.executeLocked(operationId));
  }

  status(operationId: string): Promise<OperationRecord> {
    return this.lease.run(operationId, () => this.statusLocked(operationId));
  }

  private async finishIndexing(operationId: string, plan: RelayedWithdrawPlan): Promise<OperationRecord> {
    const operation = await this.operations.get(operationId);
    if (operation.stage !== "indexing") return operation;
    const confirmed = operation.transactions.find((entry) =>
      entry.state === "confirmed" && entry.purpose === "relayed-withdraw");
    if (!confirmed) throw new Error("Confirmed relayed withdrawal transaction is unavailable");
    if (plan.source === "payroll") {
      await this.client.backend.confirmPrivacyWithdraw(plan.allocationId, confirmed.hash);
    }
    return this.operations.transition(operationId, "completed", ["indexing"]);
  }

  private async track(operationId: string, remote: RelayerOperation): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    if (remote.chainId !== operation.chainId) throw new Error("Relayer operation belongs to a different chain");
    if (remote.operation !== undefined && remote.operation !== "withdraw") {
      throw new Error("Relayer returned a different operation type");
    }
    const hash = remote.transactionHash;
    if (hash) {
      const tracked = operation.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
      if (!tracked) operation = await this.operations.registerTransaction(operationId, "relayed-withdraw", hash);
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
      return this.finishIndexing(operationId, planFrom(operation));
    }
    return this.operations.get(operationId);
  }

  private async statusLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    await this.client.assertAccount(operation.chainId);
    const plan = planFrom(operation);
    if (operation.stage === "indexing") return this.finishIndexing(operationId, plan);
    if (operation.stage === "completed" || operation.stage === "cancelled" || operation.stage === "expired" || operation.stage === "failed") return operation;
    const payload = await this.payloads.get(operationId);
    if (!payload.relayerOperationId) return operation;
    if (operation.stage === "proving") operation = await this.operations.transition(operationId, "pending", ["proving"]);
    const remote = await new RelayerClient(plan.relayerUrl).operation(payload.relayerOperationId);
    return this.track(operationId, remote);
  }

  private async executeLocked(operationId: string): Promise<OperationRecord> {
    let operation = await this.operations.get(operationId);
    await this.client.assertAccount(operation.chainId);
    const plan = planFrom(operation);
    if (operation.stage === "prepared") operation = await this.operations.beginExecution(operationId, "relayed-withdraw", operation.planHash);
    else if (operation.stage === "failed" && operation.resumeStage) operation = await this.operations.retryFailed(operationId);
    if (operation.stage === "completed") return operation;
    if (operation.stage === "indexing") return this.finishIndexing(operationId, plan);
    if (operation.stage === "expired" || operation.stage === "cancelled") throw new Error(`Operation is ${operation.stage}`);
    const payload = await this.payloads.get(operationId);
    if (payload.relayerOperationId) return this.statusLocked(operationId);
    // An exact retry may recover an accepted request after an ambiguous HTTP
    // timeout, even when its quote has since expired.
    if (payload.calldata) return this.submit(operationId, plan, payload.calldata);
    if (Date.parse(plan.quoteExpiresAt) <= Date.now()) {
      await this.operations.transition(operationId, "expired", [operation.stage]);
      throw new Error("Relayer quote expired; prepare a new relayed withdrawal");
    }
    if (operation.transactions.length > 0) throw new Error("Relayed withdrawal has a transaction but no relayer operation ID; refusing replacement");
    if (operation.stage !== "proving") throw new Error(`Relayed withdrawal cannot generate a proof from stage ${operation.stage}`);
    const selected = await this.client.chain(operation.chainId);
    if (normalizeAddress(selected.config.gravArc, selected.config.family) !== plan.gravArc) throw new Error("GravArc configuration changed after preparation");
    const password = this.client.environment.password;
    if (!password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt the allocation");
    const { info, rawSecret, source } = await decryptAllocation(this.client, operation.chainId, plan.allocationId, password);
    const token = normalizeAddress(info.token, selected.config.family);
    if (info.leafIndex !== plan.leafIndex || info.tier !== plan.tier || info.amount !== plan.allocationAmount
      || source !== plan.source || token !== plan.token) {
      throw new Error("Encrypted allocation no longer matches the prepared relayed withdrawal");
    }
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
    const calldata = encodeRelayedWithdrawCalldata(result);
    await this.payloads.saveCalldata(operationId, calldata);
    return this.submit(operationId, plan, calldata);
  }

  private async submit(operationId: string, plan: RelayedWithdrawPlan, calldata: string): Promise<OperationRecord> {
    const client = new RelayerClient(plan.relayerUrl);
    let remote: RelayerOperation;
    try {
      remote = await client.submitWithdraw({ chainId: (await this.operations.get(operationId)).chainId, quoteId: plan.quoteId, calldata });
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
    return this.track(operationId, remote);
  }
}
