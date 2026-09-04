import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { McpAccountSelection } from "./accounts/mcp.js";
import { registerWorkflowTools } from "./mcp/tools.js";

const echoInputSchema = z.object({
  message: z.string().min(1).describe("The text to return unchanged."),
});

const echoOutputSchema = z.object({
  message: z.string(),
});

export function createServer(options: {
  accounts?: McpAccountSelection;
  accountAddress?: string;
  allowedAccountAddresses?: string[];
} = {}): McpServer {
  const accountAddress = options.accounts?.selected.address ?? options.accountAddress;
  const allowedAccountAddresses = options.accounts ? [...options.accounts.allowedAddresses] : options.allowedAccountAddresses;
  const server = new McpServer(
    {
      name: "pact-privacy-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        `Use read-only discovery tools before preparing a private operation. Preparation moves no funds; execution tools require confirm=true after reviewing the immutable operation.${accountAddress ? ` The startup account is ${accountAddress}; account access is restricted to ${allowedAccountAddresses?.join(", ") ?? accountAddress}.` : ""}`,
    },
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns the supplied message unchanged.",
      inputSchema: echoInputSchema,
      outputSchema: echoOutputSchema,
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
      structuredContent: { message },
    }),
  );

  if (options.accounts) registerWorkflowTools(server, options.accounts);

  return server;
}
