import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("lists and calls the echo tool over stdio", async () => {
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
      ["echo"],
    );

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
