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

## MCP and local files

Build and test with `npm run typecheck` and `npm test`. Point an MCP client at
`dist/src/index.js` after building. The CLI and MCP use the same selected local
account. The MCP exposes `list_organizations` and requires an explicit `orgId`
for payroll recipient discovery and deposit preparation.

Profiles (including wallet private keys, passwords, and API keys) are stored in
`~/.config/pact-privacy/org/`; operation records are under
`~/.local/share/pact-privacy/org/accounts/<address>/operations/`; verified circuits
are cached under `~/.cache/pact-privacy/circuits/`. Keep these files private and
back up the wallet and secret securely. `XDG_CONFIG_HOME` and `XDG_DATA_HOME`
override the first two roots. Do not copy these files into a repository.
