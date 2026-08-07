import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { OperationRecord } from "./types.js";

const ID_PATTERN = /^op_[a-z0-9]+_[a-f0-9]{16}$/;

function clone(record: OperationRecord): OperationRecord {
  return JSON.parse(JSON.stringify(record)) as OperationRecord;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function defaultOperationDirectory(): string {
  const dataRoot = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
  return resolve(dataRoot, "pact-privacy", "operations");
}

export function legacyOperationDirectory(): string {
  return defaultOperationDirectory();
}

export class OperationStore {
  readonly directory: string;

  constructor(directory = defaultOperationDirectory()) {
    this.directory = resolve(directory);
  }

  private path(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid operation ID: ${id}`);
    const path = resolve(this.directory, `${id}.json`);
    if (!path.startsWith(`${this.directory}${sep}`)) throw new Error("Unsafe operation path");
    return path;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }

  private async write(path: string, record: OperationRecord, exclusive = false): Promise<void> {
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    if (exclusive) {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
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

  private async withLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lock = `${this.path(id)}.lock`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try {
          return await action();
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > 30_000) await rm(lock, { recursive: true, force: true });
        else await delay(20);
      }
    }
    throw new Error(`Operation is busy: ${id}`);
  }

  async create(record: OperationRecord): Promise<OperationRecord> {
    await this.ensureDirectory();
    await this.write(this.path(record.id), record, true);
    return clone(record);
  }

  async get(id: string): Promise<OperationRecord> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.path(id), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`Operation not found: ${id}`);
      throw error;
    }
    return clone(value as OperationRecord);
  }

  async update(id: string, mutate: (record: OperationRecord) => void, now = Date.now()): Promise<OperationRecord> {
    return this.withLock(id, async () => {
      const record = await this.get(id);
      mutate(record);
      record.revision += 1;
      record.updatedAt = now;
      await this.write(this.path(id), record);
      return clone(record);
    });
  }

  async list(): Promise<OperationRecord[]> {
    await this.ensureDirectory();
    const entries = await readdir(this.directory);
    const records = await Promise.all(entries
      .filter((entry) => /^op_[a-z0-9]+_[a-f0-9]{16}\.json$/.test(entry))
      .map((entry) => this.get(entry.slice(0, -5))));
    return records.sort((left, right) => right.createdAt - left.createdAt);
  }
}
