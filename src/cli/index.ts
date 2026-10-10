#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { writeEnvironment } from "../config/env.js";
import { PactPrivacyBackend } from "../backend/client.js";
import { LocalSigner } from "../wallet/local-signer.js";
import { TerminalPrompter } from "./prompts.js";
import { registerWorkflowCommands } from "./commands.js";
import { createCliExecutor } from "./executor.js";
import { resolveAccountContext } from "../accounts/context.js";
import { AccountStore } from "../accounts/store.js";
import type { Command as CommanderCommand } from "commander";

const program = new Command()
  .name("pactpay")
  .description("Local Pact Privacy CLI")
  .version("0.1.0")
  .option("--account <address>", "local account address")
  .option("--env <path>", "standalone protected environment file");

program.command("status")
  .description("Check local configuration and backend connectivity without exposing credentials")
  .option("--env <path>", "standalone environment file")
  .action(async (options: { env?: string }, command: CommanderCommand) => {
    const globals = command.optsWithGlobals() as { env?: string; account?: string };
    const envPath = options.env ?? globals.env;
    const context = await resolveAccountContext({ ...(envPath ? { envPath } : {}), ...(globals.account ? { account: globals.account } : {}) });
    const env = context.environment;
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
        const identity = await backend.assertApiKeyGrant(signer, family);
        if (!identity.scopes.includes("mcp:read")) throw new Error("API key needs mcp:read scope");
        const account = await backend.account(family);
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
  .option("--env <path>", "standalone environment file")
  .action(async (options: { env?: string }, command: CommanderCommand) => {
    const globals = command.optsWithGlobals() as { env?: string; account?: string };
    const envPath = options.env ?? globals.env;
    const context = await resolveAccountContext({ ...(envPath ? { envPath } : {}), ...(globals.account ? { account: globals.account } : {}) });
    const env = context.environment;
    const signer = new LocalSigner(env.privateKey!);
    const backend = new PactPrivacyBackend(env.backendUrl!, env.apiKey);
    const identity = await backend.apiKeyIdentity();
    const family = identity.grants[0]?.family;
    if (!family) throw new Error("API key has no family grant");
    const prompt = new TerminalPrompter();
    if (!await prompt.confirm(`Rotate API key “${identity.name}”? Its current value will stop working immediately.`)) return;
    await backend.authenticate(signer, family);
    const rotated = await backend.rotateApiKey(signer, family, identity.id);
    if (context.source === "profile") {
      await new AccountStore().updateApiKey(context.address, rotated.key);
      process.stderr.write("API key rotated and protected account profile updated.\n");
    } else {
      const path = resolve(envPath ?? ".env");
      await writeEnvironment(path, { ...env, apiKey: rotated.key }, { replace: true });
      process.stderr.write("API key rotated and secure environment updated.\n");
    }
  });

registerWorkflowCommands(program, createCliExecutor(new TerminalPrompter()));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
