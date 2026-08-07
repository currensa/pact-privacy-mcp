#!/usr/bin/env node

import "dotenv/config";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { resolveMcpAccounts } from "./accounts/mcp.js";

const accounts = await resolveMcpAccounts();
await serveStdio(() => createServer({
  accountAddress: accounts.selected.address,
  allowedAccountAddresses: [...accounts.allowedAddresses],
}));
