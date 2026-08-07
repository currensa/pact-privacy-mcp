import { OPERATION_KINDS, OPERATION_STAGES, isTerminalStage } from "./types.js";
import type {
  ChainTransactionStatus,
  OperationKind,
  OperationPlan,
  OperationRecord,
  OperationStage,
  OperationTransaction,
} from "./types.js";
import { canonicalPlan, newOperationId, operationPlanHash } from "./plan.js";
import { OperationStore } from "./store.js";
import type { CanonicalAddress } from "../core/types.js";

const HASH_PATTERN = /^(?:0x)?[a-fA-F0-9]{64}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function assertRecord(record: OperationRecord, accountAddress?: CanonicalAddress): void {
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) throw new Error(`Unsupported operation schema: ${record.id}`);
  if (accountAddress && record.accountAddress !== accountAddress) {
    if (!record.accountAddress) throw new Error(`Legacy operation ${record.id} is not account-bound; run \`pactpay account migrate\``);
    throw new Error(`Operation ${record.id} belongs to account ${record.accountAddress}, not ${accountAddress}`);
  }
  if (!OPERATION_KINDS.includes(record.kind) || !OPERATION_STAGES.includes(record.stage)) {
    throw new Error(`Operation has invalid kind or stage: ${record.id}`);
  }
  if (operationPlanHash(record.plan) !== record.planHash) throw new Error(`Operation plan integrity check failed: ${record.id}`);
}

export class OperationService {
  constructor(
    private readonly store = new OperationStore(),
    private readonly clock: () => number = Date.now,
    private readonly accountAddress?: CanonicalAddress,
  ) {}

  get directory(): string {
    return this.store.directory;
  }

  async prepare(kind: OperationKind, chainId: number, plan: OperationPlan, ttlMs = DEFAULT_TTL_MS): Promise<OperationRecord> {
    if (!Number.isSafeInteger(chainId) || chainId < 0) throw new Error("Operation chainId must be a non-negative integer");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Operation TTL must be a positive integer");
    const now = this.clock();
    const normalizedPlan = JSON.parse(canonicalPlan(plan)) as OperationPlan;
    const record: OperationRecord = {
      schemaVersion: this.accountAddress ? 2 : 1,
      ...(this.accountAddress ? { accountAddress: this.accountAddress } : {}),
      id: newOperationId(now),
      kind,
      chainId,
      stage: "prepared",
      plan: normalizedPlan,
      planHash: operationPlanHash(normalizedPlan),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
      revision: 0,
      transactions: [],
    };
    return this.store.create(record);
  }

  private async refresh(record: OperationRecord): Promise<OperationRecord> {
    assertRecord(record, this.accountAddress);
    if (record.stage === "prepared" && record.expiresAt <= this.clock()) {
      return this.store.update(record.id, (current) => {
        assertRecord(current, this.accountAddress);
        if (current.stage === "prepared" && current.expiresAt <= this.clock()) current.stage = "expired";
      }, this.clock());
    }
    return record;
  }

  async get(id: string): Promise<OperationRecord> {
    return this.refresh(await this.store.get(id));
  }

  async list(incompleteOnly = false): Promise<OperationRecord[]> {
    const records = await Promise.all((await this.store.list()).map((record) => this.refresh(record)));
    return incompleteOnly ? records.filter((record) => !isTerminalStage(record.stage)) : records;
  }

  async beginExecution(id: string, expectedKind: OperationKind, expectedPlanHash?: string): Promise<OperationRecord> {
    const current = await this.get(id);
    if (current.kind !== expectedKind) throw new Error(`Operation ${id} is ${current.kind}, not ${expectedKind}`);
    if (current.stage !== "prepared") throw new Error(`Operation cannot execute from stage ${current.stage}`);
    if (expectedPlanHash && current.planHash !== expectedPlanHash) throw new Error("Reviewed operation plan has changed");
    return this.transition(id, "proving", ["prepared"]);
  }

  async transition(id: string, stage: OperationStage, allowedFrom: OperationStage[]): Promise<OperationRecord> {
    return this.store.update(id, (record) => {
      assertRecord(record, this.accountAddress);
      if (!allowedFrom.includes(record.stage)) throw new Error(`Operation cannot move from ${record.stage} to ${stage}`);
      if (isTerminalStage(record.stage)) throw new Error(`Operation is already ${record.stage}`);
      record.stage = stage;
      delete record.error;
      delete record.resumeStage;
    }, this.clock());
  }

  async cancel(id: string): Promise<OperationRecord> {
    const current = await this.get(id);
    if (current.stage !== "prepared") throw new Error(`Only a prepared operation can be cancelled; current stage is ${current.stage}`);
    if (current.transactions.length > 0) throw new Error("Operation cannot be cancelled after a transaction hash is registered");
    return this.transition(id, "cancelled", ["prepared"]);
  }

  async registerTransaction(id: string, purpose: string, hash: string): Promise<OperationRecord> {
    if (!purpose.trim()) throw new Error("Transaction purpose is required");
    if (!HASH_PATTERN.test(hash)) throw new Error("Transaction hash must be 32 bytes");
    return this.store.update(id, (record) => {
      assertRecord(record, this.accountAddress);
      if (isTerminalStage(record.stage)) throw new Error(`Operation is already ${record.stage}`);
      if (!["proving", "broadcasting", "pending"].includes(record.stage)) {
        throw new Error(`A transaction cannot be registered from stage ${record.stage}`);
      }
      if (record.transactions.some((transaction) => transaction.hash.toLowerCase() === hash.toLowerCase())) return;
      record.transactions.push({
        purpose,
        chainId: record.chainId,
        hash,
        state: "registered",
        createdAt: this.clock(),
      });
      record.stage = "broadcasting";
    }, this.clock());
  }

  async markBroadcast(id: string, hash: string): Promise<OperationRecord> {
    return this.store.update(id, (record) => {
      assertRecord(record, this.accountAddress);
      const transaction = record.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
      if (!transaction) throw new Error("Transaction hash must be registered before broadcast");
      if (transaction.state !== "registered") throw new Error(`Transaction is already ${transaction.state}`);
      transaction.state = "pending";
      transaction.broadcastAt = this.clock();
      record.stage = "pending";
    }, this.clock());
  }

  async reconcile(
    id: string,
    status: (transaction: OperationTransaction) => Promise<ChainTransactionStatus>,
  ): Promise<OperationRecord> {
    const current = await this.get(id);
    for (const transaction of current.transactions) {
      if (!transaction.broadcastAt || transaction.state === "confirmed" || transaction.state === "failed") continue;
      const result = await status(transaction);
      await this.store.update(id, (record) => {
        assertRecord(record, this.accountAddress);
        const stored = record.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
        if (!stored || stored.state === "confirmed" || stored.state === "failed") return;
        stored.checkedAt = this.clock();
        stored.state = result.state === "not_found" || result.state === "unknown" ? "unknown" : result.state;
        if (result.blockNumber !== undefined) stored.blockNumber = result.blockNumber;
        if (result.error) stored.error = result.error;
        if (stored.state === "failed") {
          record.stage = "failed";
          record.error = result.error ?? `Transaction failed: ${stored.hash}`;
          delete record.resumeStage;
        }
      }, this.clock());
    }
    return this.get(id);
  }

  async recordTransactionStatus(id: string, hash: string, result: ChainTransactionStatus): Promise<OperationRecord> {
    return this.store.update(id, (record) => {
      assertRecord(record, this.accountAddress);
      const transaction = record.transactions.find((entry) => entry.hash.toLowerCase() === hash.toLowerCase());
      if (!transaction) throw new Error(`Transaction is not registered: ${hash}`);
      transaction.checkedAt = this.clock();
      transaction.state = result.state === "not_found" || result.state === "unknown" ? "unknown" : result.state;
      if (result.blockNumber !== undefined) transaction.blockNumber = result.blockNumber;
      if (result.error) transaction.error = result.error;
      if (transaction.state === "failed") {
        record.stage = "failed";
        record.error = result.error ?? `Transaction failed: ${hash}`;
        delete record.resumeStage;
      }
    }, this.clock());
  }

  async fail(id: string, error: unknown): Promise<OperationRecord> {
    const message = error instanceof Error ? error.message : String(error);
    return this.store.update(id, (record) => {
      assertRecord(record, this.accountAddress);
      if (isTerminalStage(record.stage)) throw new Error(`Operation is already ${record.stage}`);
      record.resumeStage = record.stage;
      record.stage = "failed";
      record.error = message.slice(0, 1000);
    }, this.clock());
  }

  async retryFailed(id: string): Promise<OperationRecord> {
    return this.store.update(id, (record) => {
      assertRecord(record, this.accountAddress);
      if (record.stage !== "failed" || !record.resumeStage) {
        throw new Error("Operation failure is not safely resumable");
      }
      record.stage = record.resumeStage;
      delete record.resumeStage;
      delete record.error;
    }, this.clock());
  }
}
