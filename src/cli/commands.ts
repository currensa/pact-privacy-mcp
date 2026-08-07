import type { Command } from "commander";

export type CliValue = string | boolean | string[] | undefined;
export type CliOptions = Record<string, CliValue>;

export type CliInvocation = {
  command: string;
  arguments: string[];
  options: CliOptions;
};

export type CliExecutor = (invocation: CliInvocation) => Promise<void>;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function invoke(executor: CliExecutor, command: string, argumentNames: string[] = []) {
  return async (...values: unknown[]): Promise<void> => {
    const commandObject = values.at(-1) as Command;
    const args = values.slice(0, argumentNames.length).map(String);
    await executor({
      command,
      arguments: args,
      options: commandObject.optsWithGlobals() as CliOptions,
    });
  };
}

function chainOption(command: Command): Command {
  return command.requiredOption("--chain <chain-id>", "chain ID");
}

export function registerWorkflowCommands(program: Command, executor: CliExecutor): void {
  const account = program.command("account").description("Manage local Pact Privacy accounts");
  account.command("add")
    .description("Generate or import and register another account")
    .option("--backend <url>", "backend URL; defaults to the shared setting")
    .option("--family <family>", "evm, tron, or both")
    .action(invoke(executor, "account.add"));
  account.command("list")
    .description("List local accounts without credentials")
    .action(invoke(executor, "account.list"));
  account.command("show")
    .description("Show one local account without credentials")
    .argument("[address]")
    .action(invoke(executor, "account.show", ["address"]));
  account.command("use")
    .description("Select the default account")
    .argument("<address>")
    .action(invoke(executor, "account.use", ["address"]));
  account.command("remove")
    .description("Remove local credentials without deleting the backend account")
    .argument("<address>")
    .option("--confirm", "confirm removal")
    .action(invoke(executor, "account.remove", ["address"]));
  account.command("migrate")
    .description("Explicitly migrate a legacy environment and its operations")
    .option("--env <path>", "legacy environment file", ".env")
    .action(invoke(executor, "account.migrate"));

  const chain = program.command("chain").description("Inspect supported chains");
  chain.command("list")
    .description("List supported chains")
    .action(invoke(executor, "chain.list"));

  const token = program.command("token").description("Inspect and manage fungible tokens");
  chainOption(token.command("list").description("List configured tokens"))
    .action(invoke(executor, "token.list"));
  chainOption(token.command("approve").description("Approve a fungible-token allowance"))
    .requiredOption("--token <token>", "token symbol or address")
    .requiredOption("--spender <spender>", "configured spender or address")
    .requiredOption("--amount <amount>", "decimal amount or unlimited")
    .option("--confirm", "confirm without an interactive prompt")
    .action(invoke(executor, "token.approve"));

  const receiver = program.command("receiver").description("Inspect registered receivers");
  receiver.command("list")
    .description("List registered receivers")
    .option("--family <family>", "evm or tron")
    .option("--address <address>", "receiver address")
    .action(invoke(executor, "receiver.list"));

  const address = program.command("address").description("Inspect locally derived addresses");
  address.command("show")
    .description("Show addresses derived from the configured private key")
    .option("--family <family>", "evm or tron")
    .action(invoke(executor, "address.show"));

  const balance = program.command("balance").description("Read native and token balances");
  chainOption(balance.command("list").description("List balances for configured assets"))
    .option("--address <address>", "address; defaults to the local account")
    .action(invoke(executor, "balance.list"));
  chainOption(balance.command("get").description("Read one asset balance"))
    .requiredOption("--token <token>", "native, token symbol, or token address")
    .option("--address <address>", "address; defaults to the local account")
    .action(invoke(executor, "balance.get"));

  const allowance = program.command("allowance").description("Read token allowances");
  chainOption(allowance.command("get").description("Read one token allowance"))
    .requiredOption("--token <token>", "token symbol or address")
    .requiredOption("--spender <spender>", "configured spender or address")
    .option("--address <address>", "owner address; defaults to the local account")
    .action(invoke(executor, "allowance.get"));

  const transaction = program.command("transaction").description("Inspect transactions");
  chainOption(transaction.command("status").description("Read transaction status"))
    .requiredOption("--hash <hash>", "transaction hash or ID")
    .action(invoke(executor, "transaction.status"));

  const deposit = program.command("deposit").description("Manage private deposits");
  chainOption(deposit.command("list").description("List deposits owned by the local account"))
    .option("--leaf-index <index>", "filter by deposit leaf index")
    .action(invoke(executor, "deposit.list"));
  chainOption(deposit.command("prepare").description("Prepare a private deposit"))
    .requiredOption("--token <token>", "token symbol or address")
    .option("--receiver <address:amount>", "receiver and decimal amount; repeatable", collect, [])
    .option("--receivers <csv-path>", "CSV containing address,amount rows")
    .option("--refund", "include depositor refund support")
    .action(invoke(executor, "deposit.prepare"));
  deposit.command("execute")
    .description("Execute a prepared private deposit")
    .argument("<operation-id>")
    .option("--confirm", "confirm execution")
    .action(invoke(executor, "deposit.execute", ["operationId"]));

  const allocation = program.command("allocation").description("Inspect incoming private allocations");
  chainOption(allocation.command("list").description("List incoming encrypted allocations"))
    .option("--unwithdrawn", "show only allocations with funds remaining")
    .action(invoke(executor, "allocation.list"));

  const transfer = program.command("transfer").description("Transfer native or fungible tokens");
  chainOption(transfer.command("native").description("Transfer native currency"))
    .requiredOption("--to <address>", "recipient address")
    .requiredOption("--amount <amount>", "decimal amount")
    .option("--confirm", "confirm without an interactive prompt")
    .action(invoke(executor, "transfer.native"));
  chainOption(transfer.command("token").description("Transfer a fungible token"))
    .requiredOption("--token <token>", "token symbol or address")
    .requiredOption("--to <address>", "recipient address")
    .requiredOption("--amount <amount>", "decimal amount")
    .option("--confirm", "confirm without an interactive prompt")
    .action(invoke(executor, "transfer.token"));

  const withdraw = program.command("withdraw").description("Manage private withdrawals");
  chainOption(withdraw.command("prepare").description("Prepare a private withdrawal"))
    .requiredOption("--allocation <id>", "allocation ID")
    .option("--amount <amount>", "decimal amount")
    .option("--all", "withdraw all remaining funds")
    .action(invoke(executor, "withdraw.prepare"));
  withdraw.command("execute")
    .description("Execute a prepared private withdrawal")
    .argument("<operation-id>")
    .option("--confirm", "confirm execution")
    .action(invoke(executor, "withdraw.execute", ["operationId"]));

  const refund = program.command("refund").description("Manage private refunds");
  chainOption(refund.command("prepare").description("Prepare a private refund"))
    .requiredOption("--leaf-index <index>", "deposit leaf index")
    .action(invoke(executor, "refund.prepare"));
  refund.command("execute")
    .description("Execute a prepared private refund")
    .argument("<operation-id>")
    .option("--confirm", "confirm execution")
    .action(invoke(executor, "refund.execute", ["operationId"]));

  const defi = program.command("defi").description("Manage EVM-only private DeFi withdrawals");
  chainOption(defi.command("prepare").description("Prepare an EVM DeFi withdrawal"))
    .requiredOption("--allocation <id>", "allocation ID")
    .requiredOption("--amount <amount>", "decimal input amount")
    .requiredOption("--protocol <protocol>", "configured DeFi protocol")
    .requiredOption("--output-token <token>", "output token symbol or address")
    .requiredOption("--min-output <amount>", "minimum decimal output amount")
    .option("--to <address>", "public output recipient")
    .option("--receiver <address:amount>", "private redeposit receiver; repeatable", collect, [])
    .option("--private-redeposit", "privately redeposit the output")
    .option("--refund", "include refund support for the private redeposit")
    .action(invoke(executor, "defi.prepare"));
  defi.command("execute")
    .description("Execute a prepared EVM DeFi withdrawal")
    .argument("<operation-id>")
    .option("--confirm", "confirm execution")
    .action(invoke(executor, "defi.execute", ["operationId"]));

  const operation = program.command("operation").description("Inspect and recover durable operations");
  operation.command("status")
    .description("Show a durable operation")
    .argument("<operation-id>")
    .action(invoke(executor, "operation.status", ["operationId"]));
  operation.command("list")
    .description("List durable operations")
    .option("--incomplete", "show only incomplete operations")
    .option("--all-accounts", "show operations for every local account")
    .action(invoke(executor, "operation.list"));
  operation.command("cancel")
    .description("Cancel a preparation before any transaction is broadcast")
    .argument("<operation-id>")
    .action(invoke(executor, "operation.cancel", ["operationId"]));
  operation.command("resume")
    .description("Safely resume an incomplete operation")
    .argument("<operation-id>")
    .action(invoke(executor, "operation.resume", ["operationId"]));
}
