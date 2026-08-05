import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const echoInputSchema = z.object({
  message: z.string().min(1).describe("The text to return unchanged."),
});

const echoOutputSchema = z.object({
  message: z.string(),
});

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "pact-privacy-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Use the echo tool to verify that this MCP server is connected and responding.",
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

  return server;
}
