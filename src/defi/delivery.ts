import { BackendError } from "../backend/client.js";
import type { DepositDelivery } from "../deposit/payload-store.js";
import type { OperationRecord, OperationStage } from "../operations/types.js";
import { OperationService } from "../operations/service.js";
import type { PactPrivacyClient } from "../runtime/client.js";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function deliverRedeposit(client: PactPrivacyClient, operations: OperationService, operation: OperationRecord, value: DepositDelivery, leafIndex: number, blockNumber: number): Promise<void> {
  const deadline = Date.now() + ((await client.chain(operation.chainId)).config.family === "tron" ? 180_000 : 90_000);
  while (true) {
    try {
      await client.backend.saveDeposition({
        leafIndex, chainId: operation.chainId, blockNumber, encContent: value.deposition.encContent,
        canRefund: value.deposition.canRefund, isRefunded: false, depositInfo: value.deposition.depositInfo,
      });
      break;
    } catch (error) {
      if (!(error instanceof BackendError) || (error.status !== 409 && error.status !== 503) || Date.now() >= deadline) throw error;
      await delay(3_000);
    }
  }
  let current = await operations.get(operation.id);
  if (current.stage === "indexing") current = await operations.transition(operation.id, "delivering", ["indexing"]);
  for (const message of value.messages) await client.backend.saveMessage({ ...message, chainId: operation.chainId, leafIndex });
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
