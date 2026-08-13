# Pact Privacy MCP and CLI

A local TypeScript client for Pact Privacy. The same modules back the stdio MCP
server and the interactive walletless CLI. ZK proofs, wallet signatures,
account-secret encryption, and circuit-artifact verification run locally.

## Requirements

- Node.js 20 or newer
- npm

## Tuturial

### 1. Install dependencies

```bash
npm install
```

### 2. Create a local account

Run the interactive initialization command:

```bash
npm run cli -- account add
```

Choose EVM, TRON, or both. The command can generate or import a private key,
initialize the selected Pact Privacy accounts, create an API key, and write a
protected account profile. Add as many accounts as needed, then inspect or
select them with:

```bash
npm run cli -- account list
npm run cli -- account use <address>
```

Plaintext account secrets are never stored. When prompted for API-key validity,
enter a positive number of days or `never` for a key without an expiry date.

### 3. Check the configuration

```bash
npm run cli -- status
npm run cli -- chain list
```

The status command verifies the backend connection, local account, and API-key
grants without displaying credentials.

To replace the configured API key later, run:

```bash
npm run cli -- rotate-api-key
```

### 4. Use the CLI

The complete command reference, parameters, workflows, and examples are in
[command.md](./command.md). To list the commands locally, run:

```bash
npm run cli -- --help
```

### 5. Build and test

```bash
npm run typecheck
npm test
npm run build
```

### 6. Configure the MCP server

The payment MCP tools are not complete yet, but their protected profiles,
API-key, circuit-cache, and build preparation are the same as the CLI steps
above. After building, register the compiled stdio entry point:

```bash
codex mcp add pact-privacy -- node /absolute/path/to/pact-privacy-mcp/dist/src/index.js
codex mcp list
```

For Claude Code:

```bash
claude mcp add --transport stdio pact-privacy -- node /absolute/path/to/pact-privacy-mcp/dist/src/index.js
claude mcp list
```

The current MCP server exposes only the connectivity test tool. Restart the MCP
client after rebuilding or changing its configuration.

MCP uses the saved default account. Set `PACT_PRIVACY_MCP_ACCOUNTS` to a
comma-separated startup allowlist before enabling future fund-moving tools; the
default account must be included.

The MCP server uses stdout exclusively for protocol messages. The CLI writes
status to stderr and never prints private keys, passwords, secrets, or API keys.

Runtime tools choose `chainId` per operation and infer EVM/TRON from backend
configuration. A configured API key is checked for a matching
`(address, family)` grant before a chain runtime is created.

## Local storage

Circuit artifacts are cached by default in:

```text
~/.cache/pact-privacy/circuits/
```

Set `PACT_PRIVACY_CIRCUIT_CACHE_DIR` in a standalone `.env` to use a different
circuit-cache directory.

Protected account profiles and the shared default-account setting are stored in:

```text
~/.config/pact-privacy/
```

Prepared and executed operation records are stored per account in:

```text
~/.local/share/pact-privacy/accounts/<canonical-address>/operations/
```

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` replace the corresponding default roots.
Use global `--account <EVM-or-TRON-address>` to override the saved default for
one command. `PACT_PRIVACY_ACCOUNT` provides a process-level default, while an
explicit `--env <path>` runs as a standalone profile.

## Current tool

### `echo`

Input:

```json
{
  "message": "hello, MCP"
}
```

The tool returns the same value as both text content and structured content.
