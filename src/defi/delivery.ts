import { BackendError } from "../backend/client.js";
import type { DepositDelivery } from "../deposit/payload-store.js";
import type { OperationRecord, OperationStage } from "../operations/types.js";
import { OperationService } from "../operations/service.js";
import type { PactPrivacyClient } from "../runtime/client.js";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function deliverRedeposit(client: PactPrivacyClient, operations: OperationService, operation: OperationRecord, value: DepositDelivery, leafIndex: number, txHash: string): Promise<void> {
  if (leafIndex !== value.predictedLeafIndex || !value.depositLeaf || value.deposition.canRefund !== 0) {
    throw new Error("Confirmed DeFi re-deposit does not match its encrypted delivery");
  }
  const deadline = Date.now() + 90_000;
  while (true) {
    try {
      const result = await client.backend.confirmDefiDeposit({
        submission: operation.kind === "relayed-defi" ? "relayed" : "direct",
        caipChainId: `eip155:${operation.chainId}`, txHash, leafIndex, depositLeaf: value.depositLeaf,
        withdrawMessages: value.messages,
      });
      if (!result.success) throw new Error("Organization DeFi deposit confirmation failed");
      break;
    } catch (error) {
      if (!(error instanceof BackendError) || (error.status !== 409 && error.status !== 503) || Date.now() >= deadline) throw error;
      await delay(3_000);
    }
  }
  let current = await operations.get(operation.id);
  if (current.stage === "indexing") current = await operations.transition(operation.id, "delivering", ["indexing"]);
  current = await operations.get(operation.id);
  if (current.stage === "delivering") await operations.transition(operation.id, "completed", ["delivering"]);
}

export async function enterIndexing(operations: OperationService, operationId: string): Promise<OperationRecord> {
  const current = await operations.get(operationId);
  if (current.stage === "pending" || current.stage === "broadcasting") {
    return operations.transition(operationId, "indexing", [current.stage as OperationStage]);
  }
  return current;
}
