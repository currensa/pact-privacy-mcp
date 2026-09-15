import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { DepositDelivery } from "../deposit/payload-store.js";
import { defaultOperationDirectory } from "../operations/store.js";

export type RelayedDefiPayload = { schemaVersion: 1; operationId: string; calldata?: string; relayerOperationId?: string; delivery?: DepositDelivery };

export class RelayedDefiPayloadStore {
  constructor(private readonly directory = defaultOperationDirectory()) {}
  private path(id: string) {
    if (!/^op_[a-z0-9]+_[a-f0-9]{16}$/.test(id)) throw new Error(`Invalid operation ID: ${id}`);
    return resolve(this.directory, `${id}.relayed-defi.json`);
  }
  async get(id: string): Promise<RelayedDefiPayload> {
    try { return JSON.parse(await readFile(this.path(id), "utf8")) as RelayedDefiPayload; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, operationId: id };
      throw error;
    }
  }
  private async save(value: RelayedDefiPayload) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    const path = this.path(value.operationId); const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); await chmod(path, 0o600); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }
  async saveCalldata(id: string, calldata: string, delivery?: DepositDelivery) {
    if (!/^0x[0-9a-f]+$/i.test(calldata)) throw new Error("Relayed DeFi calldata is invalid");
    const value = await this.get(id);
    if (value.calldata && value.calldata.toLowerCase() !== calldata.toLowerCase()) throw new Error("Different relayed DeFi calldata is already stored");
    await this.save({ ...value, calldata: calldata.toLowerCase(), ...(delivery ? { delivery } : {}) });
  }
  async saveRelayerOperation(id: string, remoteId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(remoteId)) throw new Error("Relayer operation ID is invalid");
    const value = await this.get(id);
    if (!value.calldata) throw new Error("Relayed DeFi calldata must be stored before submission");
    if (value.relayerOperationId && value.relayerOperationId !== remoteId) throw new Error("A different relayer operation is already stored");
    await this.save({ ...value, relayerOperationId: remoteId });
  }
}
