import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

export const CIRCUITS = ["deposit", "withdraw", "refund"] as const;
export const TIERS = [8, 16, 32, 64, 128] as const;
export type CircuitName = typeof CIRCUITS[number];
export type CircuitTier = typeof TIERS[number];

type ManifestArtifact = { path: string; size: number; sha256: string };
type CircuitManifest = {
  schemaVersion: number;
  bundleVersion: string;
  generatedAt: string;
  artifacts: Record<string, ManifestArtifact>;
};

export type CircuitBundlePaths = {
  wasmPath: string;
  zkeyPath: string;
  bundleVersion: string;
};

function expectedArtifacts(): Map<string, string> {
  const expected = new Map<string, string>();
  for (const circuit of CIRCUITS) {
    for (const tier of TIERS) {
      expected.set(`${circuit}_${tier}.wasm`, `${circuit}_${tier}_js/${circuit}_${tier}.wasm`);
      expected.set(`${circuit}_${tier}.zkey`, `${circuit}_${tier}_final.zkey`);
    }
  }
  return expected;
}

export function validateManifest(value: unknown): CircuitManifest {
  if (!value || typeof value !== "object") throw new Error("Circuit manifest is not an object");
  const manifest = value as Partial<CircuitManifest>;
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported circuit manifest schema");
  if (!/^[a-f0-9]{64}$/i.test(manifest.bundleVersion ?? "")) throw new Error("Invalid circuit bundle version");
  if (typeof manifest.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt))) {
    throw new Error("Invalid circuit manifest generation time");
  }
  if (!manifest.artifacts || typeof manifest.artifacts !== "object") throw new Error("Circuit manifest has no artifacts");
  const expected = expectedArtifacts();
  if (Object.keys(manifest.artifacts).length !== expected.size) throw new Error("Circuit manifest artifact count is invalid");
  for (const [key, path] of expected) {
    const artifact = manifest.artifacts[key];
    if (!artifact || artifact.path !== path) throw new Error(`Circuit manifest is missing ${key}`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error(`Invalid artifact size: ${key}`);
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error(`Invalid artifact checksum: ${key}`);
  }
  return manifest as CircuitManifest;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function verifiedFile(path: string, artifact: ManifestArtifact): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === artifact.size && await fileSha256(path) === artifact.sha256.toLowerCase();
  } catch {
    return false;
  }
}

export class CircuitArtifactCache {
  readonly cacheDir: string;
  readonly circuitBaseUrl: string;

  constructor(options: { backendUrl: string; cacheDir?: string; apiKey?: string; fetchImpl?: typeof fetch }) {
    const backend = options.backendUrl.replace(/\/+$/, "");
    const apiBase = backend.endsWith("/api") ? backend : `${backend}/api`;
    this.circuitBaseUrl = `${apiBase}/circuit`;
    this.cacheDir = resolve(options.cacheDir ?? resolve(homedir(), ".cache", "pact-privacy", "circuits"));
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    return this.fetchImpl(`${this.circuitBaseUrl}/${path}`, { ...init, headers });
  }

  private async manifest(): Promise<CircuitManifest> {
    const response = await this.fetch("manifest.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Failed to fetch circuit manifest (${response.status})`);
    return validateManifest(await response.json());
  }

  private artifactPath(bundleVersion: string, artifact: ManifestArtifact): string {
    const root = resolve(this.cacheDir, bundleVersion);
    const path = resolve(root, artifact.path);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Unsafe artifact path in manifest");
    return path;
  }

  private async download(bundleVersion: string, artifact: ManifestArtifact): Promise<string> {
    const target = this.artifactPath(bundleVersion, artifact);
    if (await verifiedFile(target, artifact)) return target;
    let bytes: Buffer | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.fetch(`${artifact.path}?v=${artifact.sha256}`, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!bytes) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Failed to download ${artifact.path}: ${detail}`);
    }
    if (bytes.byteLength !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256.toLowerCase()) {
      throw new Error(`Circuit artifact integrity check failed: ${artifact.path}`);
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, 0o600);
    return target;
  }

  private async removeOldBundles(current: string): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.cacheDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== current && /^[a-f0-9]{64}$/i.test(entry.name)) {
        await rm(resolve(this.cacheDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  async bundle(circuit: CircuitName, tier: CircuitTier): Promise<CircuitBundlePaths> {
    const manifest = await this.manifest();
    const wasm = manifest.artifacts[`${circuit}_${tier}.wasm`];
    const zkey = manifest.artifacts[`${circuit}_${tier}.zkey`];
    if (!wasm || !zkey) throw new Error(`Circuit bundle is unavailable: ${circuit}_${tier}`);
    const [wasmPath, zkeyPath] = await Promise.all([
      this.download(manifest.bundleVersion, wasm),
      this.download(manifest.bundleVersion, zkey),
    ]);
    await this.removeOldBundles(manifest.bundleVersion);
    return { wasmPath, zkeyPath, bundleVersion: manifest.bundleVersion };
  }
}
