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
    "--env", "private.env", "deposit", "prepare", "--chain", "11142220", "--token", "USDC",
    "--receiver", "0xAlice:1.25", "--receiver", "0xBob:2.50", "--refund",
  ]);
  assert.equal(result.command, "deposit.prepare");
  assert.deepEqual(result.arguments, []);
  assert.deepEqual(result.options.receiver, ["0xAlice:1.25", "0xBob:2.50"]);
  assert.equal(result.options.env, "private.env");
  assert.equal(result.options.refund, true);
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

test("parses account management and all-account operation listing", async () => {
  const use = await parse(["account", "use", "TAccount"]);
  assert.equal(use.command, "account.use");
  assert.deepEqual(use.arguments, ["TAccount"]);

  const list = await parse(["--account", "0xAccount", "operation", "list", "--all-accounts"]);
  assert.equal(list.command, "operation.list");
  assert.equal(list.options.account, "0xAccount");
  assert.equal(list.options.allAccounts, true);
});

test("parses refund preparation by deposit leaf", async () => {
  const result = await parse(["refund", "prepare", "--chain", "11142220", "--leaf-index", "42"]);
  assert.equal(result.command, "refund.prepare");
  assert.equal(result.options.chain, "11142220");
  assert.equal(result.options.leafIndex, "42");
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

test("parses EVM DeFi private redeposit inputs", async () => {
  const result = await parse([
    "defi", "prepare", "--chain", "11142220", "--allocation", "735", "--amount", "100",
    "--protocol", "uniswap-v3", "--output-token", "USDC", "--min-output", "99",
    "--receiver", "0xAlice:60", "--receiver", "0xBob:39", "--private-redeposit", "--refund",
  ]);
  assert.equal(result.command, "defi.prepare");
  assert.deepEqual(result.options.receiver, ["0xAlice:60", "0xBob:39"]);
  assert.equal(result.options.privateRedeposit, true);
});
