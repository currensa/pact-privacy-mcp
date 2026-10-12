# PactPay Organization MCP and CLI

The CLI and stdio MCP share a local wallet, verified circuit cache, proofs, and
recoverable operations. This branch connects to the Organization server, not
the Core server. The current configured chains are EVM; the server supplies
the available networks, tokens, contracts, and circuit manifest.

## Local setup

Use Node.js 20 or newer. Start the Organization server, then run:

```bash
npm install
npm run cli -- account add --backend https://test.pactpay.app/api
npm run cli -- status
npm run cli -- organization list
npm run cli -- chain list
```

`account add` asks for the member name and Organization invite code, generates
or imports an EVM wallet, logs in with a wallet signature, joins the
organization, registers a privacy profile if needed, and creates or accepts a
scoped API key. A public
invitation may leave membership pending approval; pending members cannot use
organization operations. The generated wallet is saved locally before remote
onboarding, so a failed setup can be retried without losing it. A later
`account add` offers to resume the incomplete default account; an already
approved membership is reused instead of joined again. `account list`, `account
show`, and `account use <address>` manage local profiles.

Use the `orgId` from `organization list` for recipient discovery and deposits:

```bash
npm run cli -- receiver list --org <org-id>
npm run cli -- deposit prepare --chain 10143 --org <org-id> --token <token> --receiver <address:amount>
npm run cli -- deposit execute <operation-id> --confirm
```

Direct withdraw, refund, and DeFi commands use the same prepare/execute pattern.
Run `npm run cli -- --help` for their exact options. The selected wallet pays
direct transaction gas. Relayed withdraw, refund, and DeFi use the independent
relayer selected with `--relayer`; proofs and private data remain local.

If a transaction confirms but encrypted server delivery is delayed, rerun its
`execute <operation-id> --confirm` command. The saved operation and signed
transaction are reused; do not create a replacement operation. Check
`operation list` or `operation status <operation-id>` first. The local API key is
returned only when created or rotated. To invalidate one, revoke it in the
Organization account settings; a revoked key cannot access the MCP.

## Install the MCP server

Complete the local setup above first so the MCP has an onboarded account to
use. Then build the stdio server:

```bash
npm install
npm run build
npm run typecheck
```

The MCP entry point is `dist/src/index.js`. MCP clients often start outside the
project directory, so use an absolute path to that file in client
configuration. You can print it from the project root with:

```bash
node -e 'console.log(require("node:path").resolve("dist/src/index.js"))'
```

The examples below use `/absolute/path/to/pact-privacy-mcp`; replace it with
the path printed on your machine. If a GUI client cannot find `node`, replace
`node` with the absolute path printed by `command -v node` on macOS or Linux,
or `where node` on Windows.

### Codex CLI, desktop app, or IDE extension

Codex clients share MCP configuration. Register the local stdio server from a
terminal:

```bash
codex mcp add pact-privacy -- node /absolute/path/to/pact-privacy-mcp/dist/src/index.js
codex mcp list
```

Alternatively, add it directly to `~/.codex/config.toml`:

```toml
[mcp_servers.pact-privacy]
command = "node"
args = ["/absolute/path/to/pact-privacy-mcp/dist/src/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

Restart the Codex client after changing the configuration. In the CLI or
desktop app, use `/mcp` to confirm that `pact-privacy` is connected. See the
[official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)
for additional configuration and approval options.

### Claude Desktop

Add the server to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pact-privacy": {
      "command": "node",
      "args": [
        "/absolute/path/to/pact-privacy-mcp/dist/src/index.js"
      ]
    }
  }
}
```

Merge the `pact-privacy` entry into an existing `mcpServers` object rather than
overwriting other servers. Fully quit and reopen Claude Desktop after saving
the file.

For Claude Code, the equivalent command is:

```bash
claude mcp add --scope user pact-privacy -- node /absolute/path/to/pact-privacy-mcp/dist/src/index.js
claude mcp list
```

Run `/mcp` inside Claude Code to verify the connection.

### Cursor

Create `~/.cursor/mcp.json` for a user-wide installation, or
`.cursor/mcp.json` in a project for a project-only installation:

```json
{
  "mcpServers": {
    "pact-privacy": {
      "command": "node",
      "args": [
        "/absolute/path/to/pact-privacy-mcp/dist/src/index.js"
      ]
    }
  }
}
```

Restart Cursor, open its MCP settings, and confirm that the server and its
tools are enabled.

### Accounts and verification

The CLI and MCP use the same selected local account. Check or change it before
starting the MCP client:

```bash
npm run cli -- account list
npm run cli -- account use <address>
npm run cli -- status
```

By default, the MCP exposes only that selected account. To allow several local
profiles, add a comma-separated `PACT_PRIVACY_MCP_ACCOUNTS` value to the MCP
server's `env` configuration. The selected default account must be included:

```json
"env": {
  "PACT_PRIVACY_MCP_ACCOUNTS": "0xFirstAccount,0xSecondAccount"
}
```

After connecting, ask the client to call `echo`, `list_accounts`, or
`list_chains`. If the server does not appear, check that:

1. `npm run build` completed and `dist/src/index.js` exists.
2. The configured server and Node.js paths are absolute and readable.
3. At least one account has completed `account add` and `status` succeeds.
4. The MCP client was fully restarted after its configuration changed.

Rebuild and restart the client after pulling source changes. You can also run
the repository's stdio smoke test and full test suite with `npm test`.

The MCP exposes `list_organizations` and requires an explicit `orgId` for
payroll recipient discovery and deposit preparation.

## Local files and security

Profiles (including wallet private keys, passwords, and API keys) are stored in
`~/.config/pact-privacy/org/`; operation records are under
`~/.local/share/pact-privacy/org/accounts/<address>/operations/`; verified circuits
are cached under `~/.cache/pact-privacy/circuits/`. Keep these files private and
back up the wallet and secret securely. `XDG_CONFIG_HOME` and `XDG_DATA_HOME`
override the first two roots. Do not copy these files into a repository.
