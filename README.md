# Pact Privacy MCP and CLI

A local TypeScript client for Pact Privacy. The same modules back the stdio MCP
server and the interactive walletless CLI. ZK proofs, wallet signatures,
account-secret encryption, and circuit-artifact verification run locally.

## Requirements

- Node.js 20 or newer
- npm

## Develop

```bash
npm install
npm test
```

Other useful commands:

```bash
npm run dev       # Run the TypeScript server over stdio
npm run cli -- --help
npm run init      # Interactive walletless onboarding
npm run build     # Compile into dist/
npm run typecheck # Check types without emitting files
npm start         # Run the compiled server
```

The server uses stdout exclusively for MCP protocol messages. The CLI also
writes status to stderr and never prints private keys, passwords, secrets, or
API keys.

## Walletless onboarding

Run `npm run init`, then choose EVM, TRON, or both. The CLI can generate or
import a private key, initializes each selected backend account with locally
derived encryption data, and writes a gitignored `.env` with mode `0600`.
Plaintext account secrets are never stored.

When prompted for API-key validity, enter a positive number of days or `never`
to create a key without an expiry date.

Use `npm run cli -- status` to check configuration and connectivity without
displaying credentials. Onboarding creates a scoped API key when one is not
provided; `npm run cli -- rotate-api-key` replaces it securely.

Runtime tools choose `chainId` per operation and infer EVM/TRON from backend
configuration. A configured API key is checked for a matching
`(address, family)` grant before a chain runtime is created.

## CLI

Learn [CLI Doc](./command.md) to use the full CLIs.

## Connect from Codex

Build the project and register its absolute entry-point path:

```bash
npm run build
codex mcp add pact-privacy -- node /absolute/path/to/pact-privacy-mcp/dist/src/index.js
codex mcp list
```

Inside Codex, open `/mcp` and ask it to call `echo` with a test message.

## Connect from Claude Code

```bash
npm run build
claude mcp add --transport stdio pact-privacy -- node /absolute/path/to/pact-privacy-mcp/dist/src/index.js
claude mcp list
```

Inside Claude Code, open `/mcp` and ask it to call `echo` with a test message.

## Current tool

### `echo`

Input:

```json
{
  "message": "hello, MCP"
}
```

The tool returns the same value as both text content and structured content.
