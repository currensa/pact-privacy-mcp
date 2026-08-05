import { createHash, randomBytes } from "node:crypto";
import type { OperationPlan } from "./types.js";

const FORBIDDEN_KEY = /private.?key|password|secret|nullifier|witness|proof|ciphertext|encrypted/i;

function canonicalValue(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`Operation plan contains an unsafe number at ${path}; store exact values as strings`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalValue(item, `${path}[${index}]`)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`Operation plans cannot persist sensitive field: ${path}.${key}`);
      if (record[key] === undefined) throw new Error(`Operation plan contains undefined at ${path}.${key}`);
      return `${JSON.stringify(key)}:${canonicalValue(record[key], `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new Error(`Operation plan contains unsupported data at ${path}`);
}

export function canonicalPlan(plan: OperationPlan): string {
  return canonicalValue(plan, "plan");
}

export function operationPlanHash(plan: OperationPlan): `0x${string}` {
  return `0x${createHash("sha256").update(canonicalPlan(plan)).digest("hex")}`;
}

export function newOperationId(now = Date.now()): string {
  return `op_${now.toString(36)}_${randomBytes(8).toString("hex")}`;
}
