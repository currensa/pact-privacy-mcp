import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultOperationDirectory } from "../operations/store.js";
import type { StoredSignedTransaction } from "../deposit/payload-store.js";

type WithdrawPayload = {
  schemaVersion: 1;
  operationId: string;
  transaction?: StoredSignedTransaction;
};

export class WithdrawPayloadStore {
  constructor(private readonly directory = defaultOperationDirectory()) {}

  private path(operationId: string): string {
    if (!/^op_[a-z0-9]+_[a-f0-9]{16}$/.test(operationId)) throw new Error(`Invalid operation ID: ${operationId}`);
    return resolve(this.directory, `${operationId}.withdraw.json`);
  }

  async get(operationId: string): Promise<WithdrawPayload> {
    try {
      return JSON.parse(await readFile(this.path(operationId), "utf8")) as WithdrawPayload;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { schemaVersion: 1, operationId };
      }
      throw error;
    }
  }

  async saveTransaction(operationId: string, transaction: StoredSignedTransaction): Promise<void> {
    const existing = await this.get(operationId);
    if (existing.transaction && existing.transaction.hash.toLowerCase() !== transaction.hash.toLowerCase()) {
      throw new Error("A different withdrawal transaction is already stored");
    }
    const payload: WithdrawPayload = { schemaVersion: 1, operationId, transaction };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = this.path(operationId);
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
}
