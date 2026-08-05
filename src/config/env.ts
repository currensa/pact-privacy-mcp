import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "dotenv";
import { Wallet } from "ethers";

export type LocalEnvironment = {
  privateKey?: string;
  backendUrl?: string;
  password?: string;
  apiKey?: string;
  tronProApiKey?: string;
  circuitCacheDir?: string;
};

const MANAGED_KEYS = [
  "PRIVATE_KEY",
  "PACT_PRIVACY_BACKEND_URL",
  "PACT_PRIVACY_PASSWORD",
  "PACT_PRIVACY_API_KEY",
  "TRON_PRO_API_KEY",
  "PACT_PRIVACY_CIRCUIT_CACHE_DIR",
] as const;

export function normalizePrivateKey(value: string): string {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  return new Wallet(normalized).privateKey;
}

export function normalizeBackendUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function assertSecureEnvFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions are too broad; run chmod 600 ${path}`);
  }
}

export async function loadEnvironment(
  path = resolve(process.cwd(), ".env"),
  options: { requireComplete?: boolean; checkPermissions?: boolean } = {},
): Promise<LocalEnvironment> {
  if (options.checkPermissions !== false) await assertSecureEnvFile(path);
  const values = parse(await readFile(path));
  const result: LocalEnvironment = {
    ...(values.PRIVATE_KEY ? { privateKey: normalizePrivateKey(values.PRIVATE_KEY) } : {}),
    ...(values.PACT_PRIVACY_BACKEND_URL ? { backendUrl: normalizeBackendUrl(values.PACT_PRIVACY_BACKEND_URL) } : {}),
    ...(values.PACT_PRIVACY_PASSWORD ? { password: values.PACT_PRIVACY_PASSWORD } : {}),
    ...(values.PACT_PRIVACY_API_KEY ? { apiKey: values.PACT_PRIVACY_API_KEY } : {}),
    ...(values.TRON_PRO_API_KEY ? { tronProApiKey: values.TRON_PRO_API_KEY } : {}),
    ...(values.PACT_PRIVACY_CIRCUIT_CACHE_DIR ? { circuitCacheDir: values.PACT_PRIVACY_CIRCUIT_CACHE_DIR } : {}),
  };
  if (options.requireComplete && (!result.privateKey || !result.backendUrl || !result.apiKey)) {
    throw new Error("PRIVATE_KEY, PACT_PRIVACY_BACKEND_URL, and PACT_PRIVACY_API_KEY are required");
  }
  return result;
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

export async function writeEnvironment(
  path: string,
  values: LocalEnvironment,
  options: { replace?: boolean } = {},
): Promise<void> {
  const absolute = resolve(path);
  let existing = "";
  try {
    existing = await readFile(absolute, "utf8");
    if (!options.replace) throw new Error(`${absolute} already exists; explicit replacement confirmation is required`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") existing = "";
    else if (!options.replace || existing === "") throw error;
  }

  const managed = new Set<string>(MANAGED_KEYS);
  const retained = existing
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !match || !managed.has(match[1] ?? "");
    });
  while (retained.at(-1) === "") retained.pop();

  const output: string[] = [...retained];
  if (output.length > 0) output.push("");
  if (values.privateKey) output.push(`PRIVATE_KEY=${quoteEnv(normalizePrivateKey(values.privateKey))}`);
  if (values.backendUrl) output.push(`PACT_PRIVACY_BACKEND_URL=${quoteEnv(normalizeBackendUrl(values.backendUrl))}`);
  if (values.password) output.push(`PACT_PRIVACY_PASSWORD=${quoteEnv(values.password)}`);
  if (values.apiKey) output.push(`PACT_PRIVACY_API_KEY=${quoteEnv(values.apiKey)}`);
  if (values.tronProApiKey) output.push(`TRON_PRO_API_KEY=${quoteEnv(values.tronProApiKey)}`);
  if (values.circuitCacheDir) output.push(`PACT_PRIVACY_CIRCUIT_CACHE_DIR=${quoteEnv(values.circuitCacheDir)}`);
  output.push("");

  const temporary = resolve(dirname(absolute), `.${absolute.split("/").at(-1)}.${process.pid}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(output.join("\n"), { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, absolute);
    await chmod(absolute, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
