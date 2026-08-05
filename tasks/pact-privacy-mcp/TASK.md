---
name: pact-privacy-mcp
description: Expose private payroll deposits, withdrawals, and refunds through a local MCP server.
---

# Pact Privacy MCP

Build a local stdio MCP server for EVM and TRON. The MCP process owns the
private key, creates proofs and ciphertext locally, submits transactions, and
uses a user API key for the Pact Privacy backend. Support DeFi on EVM only;
defer TRON DeFi.

## 1. Local client and configuration

- Require `PRIVATE_KEY`, backend URL, and one Pact Privacy API key with at
  least one authorized family grant. Support optional TRON provider
  credentials.
- Select `chainId` at tool runtime and infer its family from backend chain
  configuration; do not require fixed chain or family environment variables.
- Derive the caller address from the private key and reject an API key unless
  it grants the derived `(address, family)` for the selected chain. Accept the
  account password or family-specific secret only as protected runtime input
  when withdrawal/refund needs it. The same password text may be used for both
  families even though their derived keys differ.
- Port reusable proof, Poseidon, encryption, circuit-cache, ABI, address, and
  wallet-adapter code from `../pact-privacy-web`; extract shared packages where
  practical instead of maintaining divergent copies.
- Generate every deposit, withdrawal, and refund proof inside the MCP process.
  Private keys, secrets, passwords, nullifiers, and plaintext messages must
  never be sent to the backend or returned in tool results.
- Cache versioned circuit artifacts locally and verify them against the
  manifest before proving.

## 2. Walletless onboarding CLI

- Provide a separate interactive CLI, not an MCP tool, for users without a
  browser wallet. It must generate or import a private key, derive the address,
  and prompt for the password and family-specific secret using hidden input.
- Authenticate by signing the backend challenge locally, initialize the Pact
  Privacy account, apply for a scoped API key, and independently authorize
  each requested `(address, family)` grant.
- Write the private key, password, backend URL, and API key to a
  gitignored `.env` with mode `0600`. Do not store the plaintext secret or
  expose any credential through stdout, logs, MCP arguments, or MCP results.
- Support account status and API-key rotation. Require explicit confirmation
  before replacing existing configuration or account data.

## 3. Backend API keys

- Replace the global `API_KEY` model for MCP access with revocable user API
  keys. One key may contain multiple independently authorized
  `(address, family)` grants; separate keys remain optional for isolation.
  Store only a hash, show the key once, support expiry and scopes, and record
  creation, last use, and revocation.
- Add an API-key guard that authenticates the same `request.user` principal as
  a wallet session. Infer family from `chainId`; require an explicit family on
  routes without a chain ID, and verify the matching grant. Keep wallet
  sessions unchanged for the web frontend.
- Permit API-key access only to the routes required by MCP:
  - `GET /user` and `GET /users`;
  - `GET|POST /depositions`, `GET /depositions/messages`, and
    `PATCH /depositions/refund`;
  - `GET|POST /messages`;
  - `GET /deposit-path` and `GET /deposit-path/membership`.
- Keep chain configuration and circuit artifacts public. Do not grant API-key
  access to wallet-login, account-update, or scanner-administration routes.
- Preserve chain-family checks, ownership checks, on-chain deposit-event
  verification, idempotent message IDs, throttling, and audit-safe errors.
- Add API-key create/list/revoke and grant-management endpoints protected by a
  wallet session and fresh wallet authorization for every family grant.
  Provide an authenticated identity endpoint so the MCP can verify the key's
  grants at startup.

## 4. Frontend account page

- Add an **API keys** section to `../pact-privacy-web/app/account/page.tsx`.
- Let the signed-in user create a named, expiring MCP key, copy it once, list
  metadata and family grants, authorize or remove a grant, and revoke it.
  Never persist or redisplay the plaintext key.
- Warn that the key authorizes private-payment metadata access and backend
  writes, while the private key authorizes on-chain funds.

## 5. MCP tools

- Discovery: list chains, tokens, registered receivers, balances, allowances,
  transaction status, owned deposits, and incoming encrypted allocations.
- Web3: derive/display addresses, read native and token balances, approve
  tokens, and transfer native or fungible tokens. Follow the EVM and TRON
  behavior in `../full-privacy/local/scanner/src/index.ts` and
  `../full-privacy/local/scanner/src/tron-tool.ts`.
- `deposit`: accept one or many registered receivers, validate token decimals
  and balances, generate the deposit proof locally, approve if required,
  submit the transaction, then store the verified deposition and encrypted
  receiver/refund messages with retry-safe IDs.
- `withdraw`: decrypt the selected allocation locally, fetch a fresh membership
  path and current claimed state, generate the proof locally, submit it, and
  return only safe transaction and amount details.
- `refund`: decrypt the depositor refund data locally, fetch a fresh membership
  path and all related on-chain withdrawal state, generate the proof locally,
  submit it, then mark the deposition refunded.
- `defi` (EVM only): port the frontend quote, withdrawal, router-call, optional
  private redeposit, and encrypted-message workflow. Reject TRON chains before
  quoting or proving.

## 6. Operation model

- Use `prepare_*`, `execute_*`, and `operation_status`/`resume_operation`
  tools instead of exposing each frontend step. Preparation returns a hashed,
  immutable, short-lived plan with chain, token, recipients, amounts, fees,
  allowance, refund support, and expected transactions; it moves no funds.
- Execution requires explicit confirmation, revalidates all mutable on-chain
  and backend state, then generates fresh proofs and submits transactions.
- Persist a non-secret operation state machine and transaction hashes so proof,
  approval, confirmation, scanner indexing, and message delivery can survive
  timeouts or restarts. Resume safe post-transaction work automatically.
- Before retrying a transaction, reconcile its hash and receipt. Never repeat
  a fund-moving transaction whose outcome is unknown.
- Support progress notifications when available, but make durable status
  polling the source of truth.

## 7. Payroll workflow

- Support private one-to-many payroll batches up to the circuit tier limit,
  including reusable recipient lists, exact decimal conversion, totals, and
  optional refund support.
- Validate every receiver against registered `secretHash` and `encPubkey`
  data before proving; reject duplicates, unsupported tokens, invalid amounts,
  stale paths, and mixed-family addresses.
- Provide batch results with transaction hash, leaf index, receiver count,
  total, and per-recipient delivery outcome; do not reveal receiver secrets or
  proof witnesses.

## 8. Validation

- Unit-test schemas, address normalization, key ownership, decimal handling,
  encryption, idempotency, and API-key scope/expiry/revocation.
- Test native and token deposit, partial/full withdrawal, refund after partial
  withdrawals, EVM DeFi with optional redeposit, stale scanner data, retries,
  ambiguous receipts, and restart recovery at every operation stage on one EVM
  testnet and Nile. Confirm TRON DeFi is unavailable.
- Confirm proofs and plaintext remain local, unauthorized keys cannot cross
  users or families, and existing browser/session flows continue to work.

## Completion criteria

The MCP can safely complete and resume private payroll deposits, withdrawals,
refunds, and EVM DeFi operations using local proofs, scoped user API keys,
verified backend records, and explicit confirmation for every fund-moving
action. Core deposit, withdrawal, and refund remain available on TRON.
