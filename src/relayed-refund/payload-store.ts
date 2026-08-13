import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultOperationDirectory } from "../operations/store.js";

export type RelayedRefundPayload = {
  schemaVersion: 1;
  operationId: string;
  calldata?: string;
  relayerOperationId?: string;
};

export class RelayedRefundPayloadStore {
  constructor(private readonly directory = defaultOperationDirectory()) {}

  private path(operationId: string): string {
    if (!/^op_[a-z0-9]+_[a-f0-9]{16}$/.test(operationId)) throw new Error(`Invalid operation ID: ${operationId}`);
    return resolve(this.directory, `${operationId}.relayed-refund.json`);
  }

  async get(operationId: string): Promise<RelayedRefundPayload> {
    try {
      return JSON.parse(await readFile(this.path(operationId), "utf8")) as RelayedRefundPayload;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, operationId };
      throw error;
    }
  }

  private async save(payload: RelayedRefundPayload): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = this.path(payload.operationId);
    const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      await chmod(path, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async saveCalldata(operationId: string, calldata: string): Promise<void> {
    if (!/^0x[0-9a-f]+$/i.test(calldata)) throw new Error("Relayed refund calldata is invalid");
    const existing = await this.get(operationId);
    if (existing.calldata && existing.calldata.toLowerCase() !== calldata.toLowerCase()) {
      throw new Error("Different relayed refund calldata is already stored");
    }
    await this.save({ ...existing, calldata: calldata.toLowerCase() });
  }

  async saveRelayerOperation(operationId: string, relayerOperationId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(relayerOperationId)) {
      throw new Error("Relayer operation ID is invalid");
    }
    const existing = await this.get(operationId);
    if (!existing.calldata) throw new Error("Relayed refund calldata must be stored before submission");
    if (existing.relayerOperationId && existing.relayerOperationId !== relayerOperationId) {
      throw new Error("A different relayer operation is already stored");
    }
    await this.save({ ...existing, relayerOperationId });
  }
}
