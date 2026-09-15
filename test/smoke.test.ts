import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("lists synchronized workflow tools and calls echo over stdio", async () => {
  const serverPath = fileURLToPath(
    new URL("../src/index.js", import.meta.url),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "pipe",
  });
  const client = new Client({
    name: "pact-privacy-mcp-smoke-test",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(({ name }) => name),
      [
        "echo",
        "list_accounts",
        "relayer_status",
        "list_chains", "list_tokens", "list_receivers", "show_addresses",
        "list_balances", "get_balance", "get_allowance", "transaction_status",
        "list_deposits", "list_allocations", "list_refundable_deposits",
        "approve_token", "transfer_native", "transfer_token",
        "prepare_deposit", "execute_deposit", "prepare_withdraw", "execute_withdraw",
        "prepare_relayed_withdraw", "execute_relayed_withdraw", "relayed_withdraw_status",
        "prepare_refund", "execute_refund", "prepare_relayed_refund",
        "execute_relayed_refund", "relayed_refund_status",
        "quote_defi", "prepare_defi", "execute_defi", "quote_relayed_defi", "prepare_relayed_defi",
        "execute_relayed_defi", "relayed_defi_status",
        "list_operations", "operation_status", "cancel_operation", "resume_operation",
      ],
    );

    const transfer = tools.tools.find(({ name }) => name === "transfer_native");
    assert.ok(transfer);
    assert.ok(JSON.stringify(transfer.inputSchema).includes('"const":true'));

    const withdraw = tools.tools.find(({ name }) => name === "prepare_withdraw");
    assert.ok(withdraw);
    assert.ok(JSON.stringify(withdraw.inputSchema).includes('"recipient"'));

    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello, MCP" },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [
      { type: "text", text: "hello, MCP" },
    ]);
    assert.deepEqual(result.structuredContent, {
      message: "hello, MCP",
    });
  } finally {
    await client.close();
  }
});
