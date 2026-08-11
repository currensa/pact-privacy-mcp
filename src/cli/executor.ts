import { resolve } from "node:path";
import type { ChainFamily } from "../core/types.js";
import { DiscoveryService } from "../discovery/service.js";
import { PactPrivacyClient } from "../runtime/client.js";
import { Web3Service } from "../web3/service.js";
import type { CliExecutor, CliInvocation, CliOptions } from "./commands.js";
import type { Prompter } from "./prompts.js";
import { OperationService } from "../operations/service.js";
import { DepositPreparationService, readDepositRecipients } from "../deposit/prepare.js";
import { DepositExecutionService } from "../deposit/execute.js";
import { WithdrawPreparationService } from "../withdraw/prepare.js";
import { WithdrawExecutionService } from "../withdraw/execute.js";
import { RefundPreparationService } from "../refund/prepare.js";
import { RefundExecutionService } from "../refund/execute.js";
import { RelayedWithdrawPreparationService } from "../relayed-withdraw/prepare.js";
import { RelayedWithdrawExecutionService } from "../relayed-withdraw/execute.js";
import { AccountStore, accountOperationDirectory, profileFromEnvironment } from "../accounts/store.js";
import { resolveAccountContext } from "../accounts/context.js";
import { migrateLegacyAccount } from "../accounts/migration.js";
import { OperationStore } from "../operations/store.js";
import { OnboardingService } from "./onboarding.js";

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
    const accountStore = new AccountStore();
    const operationId = invocation.arguments[0];
    if (invocation.command === "account.add") {
      const shared = await accountStore.shared();
      const backendUrl = stringOption(invocation.options, "backend") ?? shared.backendUrl;
      const family = stringOption(invocation.options, "family");
      const provisioned = await new OnboardingService(prompter).provision({
        ...(backendUrl ? { backendUrl } : {}),
        ...(family ? { family } : {}),
      });
      const profile = await accountStore.add(profileFromEnvironment(provisioned.environment, provisioned.families));
      await accountStore.updateShared({ backendUrl: provisioned.environment.backendUrl });
      output({
        address: profile.address,
        families: profile.families,
        addresses: profile.addresses,
        isDefault: (await accountStore.shared()).defaultAccount === profile.address,
      });
      return;
    }
    if (invocation.command === "account.list") {
      output(await accountStore.list());
      return;
    }
    if (invocation.command === "account.show") {
      const identifier = invocation.arguments[0] ?? stringOption(invocation.options, "account") ?? process.env.PACT_PRIVACY_ACCOUNT ?? (await accountStore.shared()).defaultAccount;
      if (!identifier) throw new Error("No account selected");
      const profile = await accountStore.get(identifier);
      output({
        address: profile.address,
        families: profile.families,
        addresses: profile.addresses,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        isDefault: (await accountStore.shared()).defaultAccount === profile.address,
      });
      return;
    }
    if (invocation.command === "account.use") {
      const identifier = invocation.arguments[0];
      if (!identifier) throw new Error("Account address is required");
      const selected = await accountStore.use(identifier);
      output({ address: selected.address, isDefault: true });
      return;
    }
    if (invocation.command === "account.migrate") {
      output(await migrateLegacyAccount(resolve(stringOption(invocation.options, "env") ?? ".env"), accountStore));
      return;
    }
    if (invocation.command === "account.remove") {
      const identifier = invocation.arguments[0];
      if (!identifier) throw new Error("Account address is required");
      const profile = await accountStore.get(identifier);
      const accountOperations = new OperationService(
        new OperationStore(accountOperationDirectory(profile.address)),
        Date.now,
        profile.address,
      );
      const incomplete = await accountOperations.list(true);
      const warning = incomplete.length > 0
        ? ` It has ${incomplete.length} incomplete operation(s), which will remain on disk.`
        : "";
      await confirmed(invocation.options, prompter, `Remove local credentials for ${profile.address}?${warning} The backend account will not be deleted.`);
      await accountStore.remove(profile.address);
      output({ address: profile.address, removed: true, incompleteOperations: incomplete.length });
      return;
    }

    if (invocation.command === "operation.list" && booleanOption(invocation.options, "allAccounts")) {
      if (stringOption(invocation.options, "env")) throw new Error("--all-accounts cannot be combined with --env");
      const records = await Promise.all((await accountStore.list()).map(async (profile) => (
        new OperationService(
          new OperationStore(accountOperationDirectory(profile.address)),
          Date.now,
          profile.address,
        ).list(booleanOption(invocation.options, "incomplete"))
      )));
      output(records.flat().sort((left, right) => right.createdAt - left.createdAt));
      return;
    }

    const selectedAccount = stringOption(invocation.options, "account");
    const selectedEnv = stringOption(invocation.options, "env");
    const context = await resolveAccountContext({
      ...(selectedAccount ? { account: selectedAccount } : {}),
      ...(selectedEnv ? { envPath: selectedEnv } : {}),
      store: accountStore,
    });
    const operations = new OperationService(context.operations, Date.now, context.address);
    const accountOperation = async (id: string) => {
      try {
        return await operations.get(id);
      } catch (error) {
        if (!(error instanceof Error && error.message === `Operation not found: ${id}`)) throw error;
        for (const profile of await accountStore.list()) {
          if (profile.address === context.address) continue;
          try {
            await new OperationStore(accountOperationDirectory(profile.address)).get(id);
            throw new Error(`Operation ${id} belongs to account ${profile.address}; select it with --account`);
          } catch (candidateError) {
            if (candidateError instanceof Error && candidateError.message === `Operation not found: ${id}`) continue;
            throw candidateError;
          }
        }
        throw error;
      }
    };
    if (invocation.command === "operation.status") {
      if (!operationId) throw new Error("Operation ID is required");
      output(await accountOperation(operationId));
      return;
    }
    if (invocation.command === "operation.list") {
      output(await operations.list(booleanOption(invocation.options, "incomplete")));
      return;
    }
    if (invocation.command === "operation.cancel") {
      if (!operationId) throw new Error("Operation ID is required");
      await accountOperation(operationId);
      output(await operations.cancel(operationId));
      return;
    }

    const environment = context.environment;
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
      const operation = await accountOperation(operationId);
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
      if (operation.kind === "withdraw") {
        output(await new WithdrawExecutionService(client, operations).execute(operation.id));
        return;
      }
      if (operation.kind === "relayed-withdraw") {
        output(await new RelayedWithdrawExecutionService(client, operations).execute(operation.id));
        return;
      }
      if (operation.kind === "refund") {
        output(await new RefundExecutionService(client, operations).execute(operation.id));
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
        const operation = await accountOperation(operationId);
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
      case "withdraw.prepare": {
        if (chainId === undefined) throw new Error("--chain is required");
        const amount = stringOption(invocation.options, "amount");
        output(await new WithdrawPreparationService(client, operations).prepare({
          chainId,
          allocationId: integerOption(invocation.options, "allocation", true)!,
          ...(amount ? { amount } : {}),
          all: booleanOption(invocation.options, "all"),
        }));
        return;
      }
      case "withdraw.execute": {
        if (!operationId) throw new Error("Operation ID is required");
        const operation = await accountOperation(operationId);
        if (operation.kind !== "withdraw") throw new Error(`Operation ${operationId} is not a withdrawal`);
        await confirmed(
          invocation.options,
          prompter,
          `Execute withdrawal ${operation.id} on chain ${operation.chainId} for ${String(operation.plan.expectedAmount)} base units?`,
        );
        output(await new WithdrawExecutionService(client, operations).execute(operationId));
        return;
      }
      case "relayed-withdraw.prepare": {
        if (chainId === undefined) throw new Error("--chain is required");
        const amount = stringOption(invocation.options, "amount");
        const maximumFee = stringOption(invocation.options, "maxFee");
        output(await new RelayedWithdrawPreparationService(client, operations).prepare({
          chainId,
          allocationId: integerOption(invocation.options, "allocation", true)!,
          ...(amount ? { amount } : {}),
          all: booleanOption(invocation.options, "all"),
          recipient: stringOption(invocation.options, "recipient", true)!,
          ...(maximumFee ? { maximumFee } : {}),
          relayerUrl: stringOption(invocation.options, "relayer", true)!,
        }));
        return;
      }
      case "relayed-withdraw.execute": {
        if (!operationId) throw new Error("Operation ID is required");
        const operation = await accountOperation(operationId);
        if (operation.kind !== "relayed-withdraw") throw new Error(`Operation ${operationId} is not a relayed withdrawal`);
        await confirmed(
          invocation.options,
          prompter,
          `Submit relayed withdrawal ${operation.id} on chain ${operation.chainId} for ${String(operation.plan.expectedAmount)} base units with fee ${String(operation.plan.fee)}?`,
        );
        output(await new RelayedWithdrawExecutionService(client, operations).execute(operationId));
        return;
      }
      case "relayed-withdraw.status": {
        if (!operationId) throw new Error("Operation ID is required");
        const operation = await accountOperation(operationId);
        if (operation.kind !== "relayed-withdraw") throw new Error(`Operation ${operationId} is not a relayed withdrawal`);
        output(await new RelayedWithdrawExecutionService(client, operations).status(operationId));
        return;
      }
      case "refund.prepare": {
        if (chainId === undefined) throw new Error("--chain is required");
        output(await new RefundPreparationService(client, operations).prepare({
          chainId,
          leafIndex: integerOption(invocation.options, "leafIndex", true)!,
        }));
        return;
      }
      case "refund.execute": {
        if (!operationId) throw new Error("Operation ID is required");
        const operation = await accountOperation(operationId);
        if (operation.kind !== "refund") throw new Error(`Operation ${operationId} is not a refund`);
        await confirmed(
          invocation.options,
          prompter,
          `Execute refund ${operation.id} on chain ${operation.chainId} for ${String(operation.plan.refundAmountAtPreparation)} base units?`,
        );
        output(await new RefundExecutionService(client, operations).execute(operationId));
        return;
      }
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
