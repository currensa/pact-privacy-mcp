import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultOperationDirectory } from "../operations/store.js";
import type { ChainFamily } from "../core/types.js";

export type StoredSignedTransaction = {
  purpose: "approval" | "deposit";
  family: ChainFamily;
  hash: string;
  raw: string | Record<string, unknown>;
};

export type DepositDelivery = {
  predictedLeafIndex: number;
  deposition: {
    encContent: string | null;
    canRefund: 0 | 1;
    depositInfo: string;
  };
  messages: Array<{
    address: string;
    content: string;
    secretHash: string;
    encPubkey: string;
    clientMessageId: string;
  }>;
};

type DepositPayload = {
  schemaVersion: 1;
  operationId: string;
  transactions: StoredSignedTransaction[];
  delivery?: DepositDelivery;
};

export class DepositPayloadStore {
  constructor(private readonly directory = defaultOperationDirectory()) {}

  private path(operationId: string): string {
    if (!/^op_[a-z0-9]+_[a-f0-9]{16}$/.test(operationId)) throw new Error(`Invalid operation ID: ${operationId}`);
    return resolve(this.directory, `${operationId}.deposit.json`);
  }

  private async read(operationId: string): Promise<DepositPayload> {
    try {
      return JSON.parse(await readFile(this.path(operationId), "utf8")) as DepositPayload;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { schemaVersion: 1, operationId, transactions: [] };
      }
      throw error;
    }
  }

  private async write(payload: DepositPayload): Promise<void> {
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

  async get(operationId: string): Promise<DepositPayload> {
    return this.read(operationId);
  }

  async saveTransaction(operationId: string, transaction: StoredSignedTransaction): Promise<void> {
    const payload = await this.read(operationId);
    const existing = payload.transactions.find((entry) => entry.hash.toLowerCase() === transaction.hash.toLowerCase());
    if (!existing) payload.transactions.push(transaction);
    await this.write(payload);
  }

  async saveDelivery(operationId: string, delivery: DepositDelivery): Promise<void> {
    const payload = await this.read(operationId);
    payload.delivery = delivery;
    await this.write(payload);
  }
}
