import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultOperationDirectory } from "./store.js";

const HEARTBEAT_MS = 5_000;
const REMOTE_STALE_MS = 2 * 60_000;

type LeaseOwner = {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
};

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export class OperationLease {
  readonly directory: string;

  constructor(directory = defaultOperationDirectory()) {
    this.directory = resolve(directory);
  }

  private lockPath(operationId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(operationId)) throw new Error(`Invalid lease resource: ${operationId}`);
    return resolve(this.directory, `${operationId}.execute.lock`);
  }

  private async owner(path: string): Promise<LeaseOwner | undefined> {
    try {
      const value = JSON.parse(await readFile(resolve(path, "owner.json"), "utf8")) as Partial<LeaseOwner>;
      if (
        value.schemaVersion === 1
        && typeof value.token === "string"
        && Number.isSafeInteger(value.pid)
        && typeof value.hostname === "string"
        && Number.isSafeInteger(value.createdAt)
      ) return value as LeaseOwner;
    } catch { /* incomplete or corrupted lease metadata */ }
    return undefined;
  }

  private async removeIfRecoverable(path: string): Promise<boolean> {
    const owner = await this.owner(path);
    if (owner?.hostname === hostname()) {
      if (processIsAlive(owner.pid)) return false;
      await rm(path, { recursive: true, force: true });
      return true;
    }
    const age = Date.now() - (await stat(path)).mtimeMs;
    if (age <= REMOTE_STALE_MS) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  }

  async run<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    if (!/^op_[a-z0-9]+_[a-f0-9]{16}$/.test(operationId)) throw new Error(`Invalid operation ID: ${operationId}`);
    return this.runResource(operationId, action);
  }

  async runResource<T>(resource: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.lockPath(resource);
    const owner: LeaseOwner = {
      schemaVersion: 1,
      token: randomBytes(16).toString("hex"),
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(resolve(path, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        if (attempt === 1 || !await this.removeIfRecoverable(path)) {
          throw new Error(`Resource is already executing: ${resource}`);
        }
      }
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void (async () => {
        const current = await this.owner(path);
        if (current?.token !== owner.token) { leaseLost = true; return; }
        const now = new Date();
        await utimes(path, now, now);
      })().catch(() => { leaseLost = true; });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const result = await action();
      if (leaseLost) throw new Error(`Execution lease was lost: ${resource}`);
      return result;
    } finally {
      clearInterval(heartbeat);
      const current = await this.owner(path);
      if (current?.token === owner.token) await rm(path, { recursive: true, force: true });
    }
  }
}
