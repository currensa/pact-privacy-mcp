import { resolve } from "node:path";
import type { ChainFamily } from "../core/types.js";
import { loadEnvironment } from "../config/env.js";
import { DiscoveryService } from "../discovery/service.js";
import { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import type { CliExecutor, CliInvocation, CliOptions } from "./commands.js";
import type { Prompter } from "./prompts.js";
import { OperationService } from "../operations/service.js";
import { DepositPreparationService, readDepositRecipients } from "../deposit/prepare.js";
import { DepositExecutionService } from "../deposit/execute.js";

function stringOption(options: CliOptions, name: string, required = false): string | undefined {
  const value = options[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`--${name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)} is required`);
  return undefined;
}

function booleanOption(options: CliOptions, name: string): boolean {
  return options[name] === true;
}

function arrayOption(options: CliOptions, name: string): string[] {
  const value = options[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`--${name} is invalid`);
  return value;
}

function integerOption(options: CliOptions, name: string, required = false): number | undefined {
  const value = stringOption(options, name, required);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer`);
  return parsed;
}

function familyOption(options: CliOptions): ChainFamily | undefined {
  const family = stringOption(options, "family");
  if (family === undefined) return undefined;
  if (family !== "evm" && family !== "tron") throw new Error("--family must be evm or tron");
  return family;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function confirmed(options: CliOptions, prompter: Prompter, description: string): Promise<void> {
  if (booleanOption(options, "confirm")) return;
  if (!await prompter.confirm(description)) throw new Error("Operation cancelled");
}

export function createCliExecutor(prompter: Prompter): CliExecutor {
  return async (invocation: CliInvocation): Promise<void> => {
    const operations = new OperationService();
    const operationId = invocation.arguments[0];
    if (invocation.command === "operation.status") {
      if (!operationId) throw new Error("Operation ID is required");
      output(await operations.get(operationId));
      return;
    }
    if (invocation.command === "operation.list") {
      output(await operations.list(booleanOption(invocation.options, "incomplete")));
      return;
    }
    if (invocation.command === "operation.cancel") {
      if (!operationId) throw new Error("Operation ID is required");
      output(await operations.cancel(operationId));
      return;
    }

    const envPath = resolve(stringOption(invocation.options, "env") ?? ".env");
    const environment = await loadEnvironment(envPath, { requireComplete: true, checkPermissions: true });
    const client = new PactPrivacyClient({
      ...environment,
      privateKey: environment.privateKey!,
      backendUrl: environment.backendUrl!,
    });
    try {
    const discovery = new DiscoveryService(client);
    const chainId = integerOption(invocation.options, "chain");
    const web3 = async (): Promise<Web3Service> => {
      if (chainId === undefined) throw new Error("--chain is required");
      const selected = await client.chain(chainId);
      return new Web3Service(selected.config, selected.runtime);
    };

    if (invocation.command === "operation.resume") {
      if (!operationId) throw new Error("Operation ID is required");
      const operation = await operations.get(operationId);
      if (operation.stage === "prepared") {
        output({ operation, nextAction: `Run pactpay ${operation.kind} execute ${operation.id} --confirm` });
        return;
      }
      if (operation.stage === "completed" || operation.stage === "expired" || operation.stage === "cancelled") {
        output({ operation, nextAction: null });
        return;
      }
      if (operation.kind === "deposit") {
        output(await new DepositExecutionService(client, operations).execute(operation.id));
        return;
      }
      const selected = await client.chain(operation.chainId);
      const service = new Web3Service(selected.config, selected.runtime);
      const reconciled = await operations.reconcile(operation.id, async (transaction) => {
        const status = await service.transactionStatus(transaction.hash);
        const state = status.state;
        if (state !== "pending" && state !== "confirmed" && state !== "failed" && state !== "not_found") {
          return { state: "unknown" };
        }
        return {
          state,
          ...(typeof status.blockNumber === "number" ? { blockNumber: status.blockNumber } : {}),
          ...(typeof status.error === "string" ? { error: status.error } : {}),
        };
      });
      const hasUncertainTransaction = reconciled.transactions.some((transaction) => (
        transaction.state === "pending" || transaction.state === "unknown"
      ));
      output({
        operation: reconciled,
        nextAction: hasUncertainTransaction
          ? "Wait and run operation resume again; no transaction was repeated"
          : "Transaction state reconciled; workflow-specific continuation is required",
      });
      return;
    }

    switch (invocation.command) {
      case "chain.list":
        output(await discovery.chains());
        return;
      case "token.list":
        output(await (await web3()).tokens());
        return;
      case "receiver.list":
        output(await discovery.receivers(familyOption(invocation.options), stringOption(invocation.options, "address")));
        return;
      case "address.show": {
        const family = familyOption(invocation.options);
        const families: ChainFamily[] = family ? [family] : ["evm", "tron"];
        output(families.map((selected) => ({
          family: selected,
          address: client.signer.displayAddress(selected),
          canonicalAddress: client.signer.address(selected),
        })));
        return;
      }
      case "balance.list": {
        const service = await web3();
        const address = stringOption(invocation.options, "address");
        const native = await service.nativeBalance(address);
        const tokens = await Promise.all(service.chain.erc20Tokens.map((token) => service.tokenBalance(token.address, address)));
        output({
          chainId,
          address: service.normalizeAccount(address).display,
          native: { ...native, symbol: service.chain.nativeCurrency?.symbol ?? "native" },
          tokens: tokens.map((entry) => ({ ...entry, token: entry.token.symbol })),
        });
        return;
      }
      case "balance.get": {
        const service = await web3();
        const token = stringOption(invocation.options, "token", true)!;
        const address = stringOption(invocation.options, "address");
        output(token.toLowerCase() === "native"
          ? { chainId, address: service.normalizeAccount(address).display, token: "native", ...await service.nativeBalance(address) }
          : { chainId, address: service.normalizeAccount(address).display, ...await service.tokenBalance(token, address) });
        return;
      }
      case "allowance.get":
        output(await (await web3()).allowance(
          stringOption(invocation.options, "token", true)!,
          stringOption(invocation.options, "spender", true)!,
          stringOption(invocation.options, "address"),
        ));
        return;
      case "transaction.status":
        output(await (await web3()).transactionStatus(stringOption(invocation.options, "hash", true)!));
        return;
      case "deposit.list":
        if (chainId === undefined) throw new Error("--chain is required");
        output(await discovery.depositions(chainId, integerOption(invocation.options, "leafIndex")));
        return;
      case "deposit.prepare": {
        if (chainId === undefined) throw new Error("--chain is required");
        const csvPath = stringOption(invocation.options, "receivers");
        const recipients = await readDepositRecipients(
          arrayOption(invocation.options, "receiver"),
          csvPath ? resolve(csvPath) : undefined,
        );
        output(await new DepositPreparationService(client, operations).prepare({
          chainId,
          token: stringOption(invocation.options, "token", true)!,
          recipients,
          refund: booleanOption(invocation.options, "refund"),
        }));
        return;
      }
      case "deposit.execute": {
        if (!operationId) throw new Error("Operation ID is required");
        const operation = await operations.get(operationId);
        if (operation.kind !== "deposit") throw new Error(`Operation ${operationId} is not a deposit`);
        await confirmed(
          invocation.options,
          prompter,
          `Execute deposit ${operation.id} on chain ${operation.chainId} for ${String(operation.plan.totalAmount)} base units?`,
        );
        output(await new DepositExecutionService(client, operations).execute(operationId));
        return;
      }
      case "allocation.list":
        if (chainId === undefined) throw new Error("--chain is required");
        if (!environment.password) throw new Error("PACT_PRIVACY_PASSWORD is required to decrypt allocations");
        output(await discovery.allocations(chainId, environment.password, booleanOption(invocation.options, "unwithdrawn")));
        return;
      case "token.approve": {
        const service = await web3();
        const token = stringOption(invocation.options, "token", true)!;
        const spender = stringOption(invocation.options, "spender", true)!;
        const amount = stringOption(invocation.options, "amount", true)!;
        const details = await service.token(token);
        const raw = amount.toLowerCase() === "unlimited" ? "unlimited" : service.parseTokenAmount(amount, details.decimals).toString();
        await confirmed(invocation.options, prompter, `Approve ${amount} ${details.symbol} (${raw} base units) for ${service.resolveSpender(spender)}?`);
        output(await service.approve(token, spender, amount));
        return;
      }
      case "transfer.native": {
        const service = await web3();
        const to = stringOption(invocation.options, "to", true)!;
        const amount = stringOption(invocation.options, "amount", true)!;
        const decimals = service.chain.nativeCurrency?.decimals ?? (service.chain.family === "tron" ? 6 : 18);
        const raw = service.parseTokenAmount(amount, decimals);
        await confirmed(invocation.options, prompter, `Transfer ${amount} ${service.chain.nativeCurrency?.symbol ?? "native"} (${raw} base units) to ${to}?`);
        output(await service.transferNative(to, amount));
        return;
      }
      case "transfer.token": {
        const service = await web3();
        const token = stringOption(invocation.options, "token", true)!;
        const to = stringOption(invocation.options, "to", true)!;
        const amount = stringOption(invocation.options, "amount", true)!;
        const details = await service.token(token);
        const raw = service.parseTokenAmount(amount, details.decimals);
        await confirmed(invocation.options, prompter, `Transfer ${amount} ${details.symbol} (${raw} base units) to ${to}?`);
        output(await service.transferToken(token, to, amount));
        return;
      }
      default:
        throw new Error(`${invocation.command} is not available until its shared workflow service is implemented`);
    }
    } finally {
      await client.close();
    }
  };
}
