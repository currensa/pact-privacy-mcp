import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerWorkflowCommands, type CliInvocation } from "../src/cli/commands.js";

async function parse(args: string[]): Promise<CliInvocation> {
  let invocation: CliInvocation | undefined;
  const program = new Command()
    .exitOverride()
    .option("--env <path>", "environment file")
    .option("--account <address>", "account address");
  registerWorkflowCommands(program, async (value) => {
    invocation = value;
  });
  await program.parseAsync(["node", "pactpay", ...args]);
  if (!invocation) throw new Error("Command did not invoke its executor");
  return invocation;
}

test("parses repeatable deposit receivers and global environment", async () => {
  const result = await parse([
    "--env", "private.env", "deposit", "prepare", "--org", "org_1", "--chain", "11142220", "--token", "USDC",
    "--receiver", "0xAlice:1.25", "--receiver", "0xBob:2.50", "--refund",
  ]);
  assert.equal(result.command, "deposit.prepare");
  assert.deepEqual(result.arguments, []);
  assert.deepEqual(result.options.receiver, ["0xAlice:1.25", "0xBob:2.50"]);
  assert.equal(result.options.env, "private.env");
  assert.equal(result.options.refund, true);
  assert.equal(result.options.org, "org_1");
});

test("parses execute and recovery operation IDs", async () => {
  const execute = await parse(["withdraw", "execute", "op_123", "--confirm"]);
  assert.equal(execute.command, "withdraw.execute");
  assert.deepEqual(execute.arguments, ["op_123"]);
  assert.equal(execute.options.confirm, true);

  const resume = await parse(["operation", "resume", "op_123"]);
  assert.equal(resume.command, "operation.resume");
  assert.deepEqual(resume.arguments, ["op_123"]);
});

test("parses a direct withdrawal recipient", async () => {
  const result = await parse([
    "withdraw", "prepare", "--chain", "11155111", "--allocation", "15", "--all",
    "--recipient", "0xdbC13E144ecd4f156fB988B4a8dFF79597002BF5",
  ]);
  assert.equal(result.command, "withdraw.prepare");
  assert.equal(result.options.recipient, "0xdbC13E144ecd4f156fB988B4a8dFF79597002BF5");
});

test("parses account management and all-account operation listing", async () => {
  const use = await parse(["account", "use", "TAccount"]);
  assert.equal(use.command, "account.use");
  assert.deepEqual(use.arguments, ["TAccount"]);

  const list = await parse(["--account", "0xAccount", "operation", "list", "--all-accounts"]);
  assert.equal(list.command, "operation.list");
  assert.equal(list.options.account, "0xAccount");
  assert.equal(list.options.allAccounts, true);
});

test("parses Organization account and membership commands", async () => {
  const add = await parse(["account", "add", "--backend", "http://localhost:3000/api"]);
  assert.equal(add.command, "account.add");
  assert.equal(add.options.backend, "http://localhost:3000/api");
  const organizations = await parse(["organization", "list"]);
  assert.equal(organizations.command, "organization.list");
});

test("parses refund preparation by deposit leaf", async () => {
  const result = await parse(["refund", "prepare", "--chain", "11142220", "--leaf-index", "42"]);
  assert.equal(result.command, "refund.prepare");
  assert.equal(result.options.chain, "11142220");
  assert.equal(result.options.leafIndex, "42");
});

test("parses read-only refundable deposit listing", async () => {
  const all = await parse(["refund", "list", "--chain", "11142220"]);
  assert.equal(all.command, "refund.list");
  assert.equal(all.options.chain, "11142220");
  assert.equal(all.options.leafIndex, undefined);

  const selected = await parse(["refund", "list", "--chain", "11142220", "--leaf-index", "42"]);
  assert.equal(selected.command, "refund.list");
  assert.equal(selected.options.leafIndex, "42");
});

test("parses relayed withdrawal quote limits and recipient", async () => {
  const result = await parse([
    "relayed-withdraw", "prepare", "--chain", "11142220", "--allocation", "735",
    "--amount", "250", "--recipient", "0x1111111111111111111111111111111111111111",
    "--max-fee", "0.25", "--relayer", "http://localhost:9000",
  ]);
  assert.equal(result.command, "relayed-withdraw.prepare");
  assert.equal(result.options.maxFee, "0.25");
  assert.equal(result.options.relayer, "http://localhost:9000");
});

test("allows a relayed withdrawal without a maximum fee", async () => {
  const result = await parse([
    "relayed-withdraw", "prepare", "--chain", "11142220", "--allocation", "735", "--all",
    "--recipient", "0x1111111111111111111111111111111111111111", "--relayer", "http://localhost:9000",
  ]);
  assert.equal(result.command, "relayed-withdraw.prepare");
  assert.equal(result.options.maxFee, undefined);
});

test("parses relayed refund recipient and optional fee limit", async () => {
  const result = await parse([
    "relayed-refund", "prepare", "--chain", "11142220", "--leaf-index", "42",
    "--refunder", "0x1111111111111111111111111111111111111111", "--max-fee", "0.50",
    "--relayer", "http://localhost:9000",
  ]);
  assert.equal(result.command, "relayed-refund.prepare");
  assert.equal(result.options.leafIndex, "42");
  assert.equal(result.options.refunder, "0x1111111111111111111111111111111111111111");
  assert.equal(result.options.maxFee, "0.50");
});

test("parses direct and relayed DeFi workflows", async () => {
  const quote = await parse([
    "defi", "quote", "--chain", "3448148188", "--input-token", "TRX", "--amount", "100",
    "--protocol", "sunswap-v4", "--output-token", "USDT", "--slippage-bps", "100",
  ]);
  assert.equal(quote.command, "defi.quote");
  assert.equal(quote.options.inputToken, "TRX");
  assert.equal(quote.options.slippageBps, "100");

  const direct = await parse([
    "defi", "prepare", "--chain", "11142220", "--allocation", "735", "--amount", "100",
    "--protocol", "mock-swap", "--output-token", "MCK", "--min-output", "99", "--to",
    "0x1111111111111111111111111111111111111111",
  ]);
  assert.equal(direct.command, "defi.prepare");
  assert.equal(direct.options.slippageBps, "50");

  const uniswap = await parse([
    "defi", "prepare", "--chain", "11155111", "--allocation", "736", "--amount", "50",
    "--protocol", "uniswap-v3", "--output-token", "WETH", "--min-output", "0.001",
    "--receiver", "0x1111111111111111111111111111111111111111:0.001", "--private-redeposit",
    "--excess-recipient", "0x2222222222222222222222222222222222222222",
  ]);
  assert.equal(uniswap.command, "defi.prepare");
  assert.equal(uniswap.options.privateRedeposit, true);
  assert.equal(uniswap.options.excessRecipient, "0x2222222222222222222222222222222222222222");

  const relayed = await parse([
    "relayed-defi", "prepare", "--chain", "3448148188", "--allocation", "9", "--withdraw-all",
    "--protocol", "sunswap-v4", "--output-token", "USDT", "--min-output", "9", "--to",
    "TReceiver", "--max-fee", "2", "--relayer", "http://localhost:9000",
  ]);
  assert.equal(relayed.command, "relayed-defi.prepare");
  assert.equal(relayed.options.withdrawAll, true);
  assert.equal(relayed.options.withdrawAmount, undefined);
  assert.equal(relayed.options.maxFee, "2");
  assert.equal(relayed.options.privateRedeposit, undefined);

  const relayedQuote = await parse([
    "relayed-defi", "quote", "--chain", "3448148188", "--tier", "8", "--input-token", "TRX",
    "--withdraw-amount", "100", "--protocol", "sunswap-v4", "--output-token", "USDT",
    "--redeposit-tier", "16", "--relayer", "http://localhost:9000",
  ]);
  assert.equal(relayedQuote.command, "relayed-defi.quote");
  assert.equal(relayedQuote.options.withdrawAmount, "100");
  assert.equal(relayedQuote.options.tier, "8");
  assert.equal(relayedQuote.options.redepositTier, "16");
});
