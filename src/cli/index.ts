#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { loadEnvironment } from "../config/env.js";
import { writeEnvironment } from "../config/env.js";
import { PactPrivacyBackend } from "../backend/client.js";
import { LocalSigner } from "../wallet/local-signer.js";
import { OnboardingService } from "./onboarding.js";
import { TerminalPrompter } from "./prompts.js";
import { registerWorkflowCommands } from "./commands.js";
import { createCliExecutor } from "./executor.js";

const program = new Command()
  .name("pactpay")
  .description("Local Pact Privacy CLI")
  .version("0.1.0")
  .option("--env <path>", "protected environment file", ".env");

program.command("init")
  .description("Initialize a walletless Pact Privacy account securely")
  .option("--env <path>", "environment file", ".env")
  .option("--backend <url>", "backend URL")
  .option("--family <family>", "evm, tron, or both")
  .option("--replace", "allow updating an existing environment file")
  .action(async (options: { env: string; backend?: string; family?: string; replace?: boolean }) => {
    const result = await new OnboardingService(new TerminalPrompter()).initialize({
      envPath: options.env,
      ...(options.backend ? { backendUrl: options.backend } : {}),
      ...(options.family ? { family: options.family } : {}),
      ...(options.replace !== undefined ? { replace: options.replace } : {}),
    });
    process.stderr.write(`Secure configuration written to ${result.envPath}\n`);
  });

program.command("status")
  .description("Check local configuration and backend connectivity without exposing credentials")
  .option("--env <path>", "environment file", ".env")
  .action(async (options: { env: string }) => {
    const env = await loadEnvironment(resolve(options.env), { checkPermissions: true });
    if (!env.privateKey || !env.backendUrl) throw new Error("PRIVATE_KEY and PACT_PRIVACY_BACKEND_URL are required");
    const signer = new LocalSigner(env.privateKey);
    const backend = new PactPrivacyBackend(env.backendUrl, env.apiKey);
    const chains = await backend.chains();
    const families = [...new Set(chains.map(({ family }) => family))];
    process.stderr.write(`Backend: ${env.backendUrl}\n`);
    process.stderr.write(`Chains: ${chains.length}\n`);
    for (const family of families) {
      process.stderr.write(`${family.toUpperCase()} address: ${signer.displayAddress(family)}\n`);
      try {
        await backend.authenticate(signer, family);
        const account = await backend.account();
        process.stderr.write(`${family.toUpperCase()} account: ${account.found ? "initialized" : "not initialized"}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${family.toUpperCase()} account: unavailable (${message})\n`);
      }
    }
    process.stderr.write(`API key: ${env.apiKey ? "configured" : "not configured"}\n`);
    if (env.apiKey) {
      try {
        const identity = await backend.apiKeyIdentity();
        process.stderr.write(`API key identity: verified (${identity.grants.map(grant => grant.family).join(", ")})\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`API key identity: unavailable (${message})\n`);
      }
    }
  });

program.command("rotate-api-key")
  .description("Rotate the configured per-user API key")
  .option("--env <path>", "environment file", ".env")
  .action(async (options: { env: string }) => {
    const path = resolve(options.env);
    const env = await loadEnvironment(path, { requireComplete: true, checkPermissions: true });
    const signer = new LocalSigner(env.privateKey!);
    const backend = new PactPrivacyBackend(env.backendUrl!, env.apiKey);
    const identity = await backend.apiKeyIdentity();
    const family = identity.grants[0]?.family;
    if (!family) throw new Error("API key has no family grant");
    const prompt = new TerminalPrompter();
    if (!await prompt.confirm(`Rotate API key “${identity.name}”? Its current value will stop working immediately.`)) return;
    await backend.authenticate(signer, family);
    const rotated = await backend.rotateApiKey(signer, family, identity.id);
    await writeEnvironment(path, { ...env, apiKey: rotated.key }, { replace: true });
    process.stderr.write("API key rotated and secure environment updated.\n");
  });

registerWorkflowCommands(program, createCliExecutor(new TerminalPrompter()));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
