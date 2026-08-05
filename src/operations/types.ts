export const OPERATION_KINDS = ["deposit", "withdraw", "refund", "defi"] as const;
export type OperationKind = typeof OPERATION_KINDS[number];

export const OPERATION_STAGES = [
  "prepared",
  "proving",
  "broadcasting",
  "pending",
  "indexing",
  "delivering",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;
export type OperationStage = typeof OPERATION_STAGES[number];

export type TransactionState = "registered" | "pending" | "confirmed" | "failed" | "unknown";

export type OperationTransaction = {
  purpose: string;
  chainId: number;
  hash: string;
  state: TransactionState;
  createdAt: number;
  broadcastAt?: number;
  checkedAt?: number;
  blockNumber?: number;
  error?: string;
};

export type OperationPlan = Record<string, unknown>;

export type OperationRecord = {
  schemaVersion: 1;
  id: string;
  kind: OperationKind;
  chainId: number;
  stage: OperationStage;
  plan: OperationPlan;
  planHash: `0x${string}`;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revision: number;
  transactions: OperationTransaction[];
  error?: string;
  resumeStage?: OperationStage;
};

export type ChainTransactionStatus = {
  state: "pending" | "confirmed" | "failed" | "not_found" | "unknown";
  blockNumber?: number;
  error?: string;
};

export function isTerminalStage(stage: OperationStage): boolean {
  return stage === "completed" || stage === "expired" || stage === "cancelled";
}
