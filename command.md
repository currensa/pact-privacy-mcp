# Pact Privacy CLI examples

After installing the published package globally, run commands with
`pactpay <command>`. During development, the equivalent source command is
`npm run cli -- <command>`.

Examples use Celo Sepolia (`11142220`) and TRON Nile (`3448148188`). Token
symbols are resolved from the selected chain configuration; an address may be
used instead when symbols are ambiguous. Commands that need the account
password read it from the protected `.env` or prompt for it without echoing.
Secrets, passwords, private keys, and proof witnesses must never be command-line
arguments or output.

Fund-moving workflows use separate `prepare` and `execute` commands. `prepare`
validates and returns an immutable plan without moving funds; `execute` requires
explicit confirmation, revalidates mutable state, generates fresh proofs, and
submits the reviewed plan. The persisted operation ID also allows safe recovery
without accidentally repeating a transaction after a timeout.

## Completed commands

Initialize an EVM and TRON account, create an API key, and write a protected
`.env` interactively:

```bash
pactpay init
pactpay init --family both
pactpay init --family evm --backend https://privacy.pactpay.app/api
```

Inspect local configuration, backend connectivity, account initialization, and
API-key grants:

```bash
pactpay status
pactpay status --env ./private.env
```

Rotate the configured API key after interactive confirmation:

```bash
pactpay rotate-api-key
```

## Discovery

List supported chains and the configured tokens on a chain:

```bash
pactpay chain list
pactpay token list --chain 11142220
pactpay token list --chain 3448148188
```

List registered receivers. A family or address filter may narrow the result:

```bash
pactpay receiver list --family evm
pactpay receiver list --family tron --address TNuoKL1ni8aoshfFL1ASca1Gou9RXwAzfn
```

Show the addresses derived from the configured private key:

```bash
pactpay address show
pactpay address show --family tron
```

Read native and token balances. When `--address` is omitted, the locally
derived address is used:

```bash
pactpay balance list --chain 11142220
pactpay balance get --chain 11142220 --token USDC
pactpay balance get --chain 3448148188 --token native
pactpay balance get --chain 3448148188 --token USDT --address TNuoKL1ni8aoshfFL1ASca1Gou9RXwAzfn
```

Read a token allowance and check a submitted transaction:

```bash
pactpay allowance get --chain 11142220 --token USDC --spender gravarc
pactpay transaction status --chain 11142220 --hash 0xabc123...
pactpay transaction status --chain 3448148188 --hash 9f4a...
```

List deposits owned by the local account and incoming encrypted allocations:

```bash
pactpay deposit list --chain 11142220
pactpay deposit list --chain 11142220 --leaf-index 42
pactpay allocation list --chain 11142220
pactpay allocation list --chain 3448148188 --unwithdrawn
```

`deposit list` queries the backend and shows only deposits that have already
been submitted and indexed. It does not show locally prepared operations; use
`operation list` or `operation status <operation-id>` for those.

## Basic Web3 operations

Approve a configured fungible token after interactive confirmation:

```bash
pactpay token approve --chain 11142220 --token USDC --spender gravarc --amount 100
pactpay token approve --chain 3448148188 --token USDT --spender gravarc --amount unlimited
```

Transfer native currency or a fungible token after interactive confirmation:

```bash
pactpay transfer native --chain 11142220 --to 0xReceiver... --amount 0.1
pactpay transfer native --chain 3448148188 --to TReceiver... --amount 10
pactpay transfer token --chain 11142220 --token USDC --to 0xReceiver... --amount 25.50
pactpay transfer token --chain 3448148188 --token USDT --to TReceiver... --amount 25.50
```

Amounts are human-readable decimal values. The CLI converts them using the
configured token decimals and displays the exact base-unit value before asking
for confirmation.

## Private deposit

Preparation validates registered receivers, balances, token decimals, circuit
tier, allowance, and estimated transactions without moving funds. It returns a
short-lived immutable operation ID:

```bash
pactpay deposit prepare --chain 11142220 --token USDC \
  --receiver 0xAlice...:1250.00 \
  --receiver 0xBob...:875.50 \
  --refund
```

A payroll CSV may replace repeated receiver arguments. It contains the columns
`address,amount`:

```bash
pactpay deposit prepare --chain 3448148188 --token USDT \
  --receivers ./payroll.csv --refund
```

Review and explicitly execute the prepared operation:

```bash
pactpay operation list
pactpay operation status op_01J...
pactpay deposit execute op_01J... --confirm
```

The preparation remains a local operation until execution succeeds and the
backend indexes it. Only then does it appear in `deposit list`.

Execution generates the proof and ciphertext locally, approves when the plan
requires it, submits the deposit, waits for indexing, and delivers retry-safe
receiver and refund messages.

## Private withdrawal

Select an allocation returned by `allocation list`, prepare a partial or full
withdrawal, then execute it:

```bash
pactpay withdraw prepare --chain 11142220 --allocation 735 --amount 250.00
pactpay withdraw prepare --chain 3448148188 --allocation 912 --all
pactpay withdraw execute op_01J... --confirm
```

The CLI decrypts locally, fetches a fresh membership path and claimed state,
and generates a fresh proof only during execution.

## Refund

Select an owned deposit by leaf index, preview the refundable result, and
execute:

```bash
pactpay refund prepare --chain 11142220 --leaf-index 42
pactpay operation status op_01J...
pactpay refund execute op_01J... --confirm
```

Preparation obtains all related withdrawal state. Execution decrypts refund
data and proves locally, submits the refund, and updates the backend only after
the transaction is confirmed. The same commands apply to TRON chains.

## DeFi withdrawal

DeFi is EVM-only. Preparation quotes the protocol call and can distribute the
output publicly or privately redeposit it:

```bash
pactpay defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol uniswap-v3 --output-token USDC --min-output 99.00 \
  --to 0xReceiver...
```

Private redeposit supports one or many registered receivers:

```bash
pactpay defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol uniswap-v3 --output-token USDC --min-output 99.00 \
  --receiver 0xAlice...:60.00 --receiver 0xBob...:39.00 \
  --private-redeposit --refund
pactpay defi execute op_01J... --confirm
```

Attempting `defi prepare` on TRON must fail before quoting or proof generation.

## Recovery

Every prepared operation has durable, non-secret state. Check progress after a
timeout or restart, then resume proof generation, transaction reconciliation,
scanner indexing, or message delivery from the last safe stage:

```bash
pactpay operation status op_01J...
pactpay operation list --incomplete
pactpay operation cancel op_01J...
pactpay operation resume op_01J...
```

`cancel` marks an unexecuted preparation as cancelled so it cannot later be
executed or resumed. Preparations also expire automatically. Once any
transaction has been broadcast, cancellation is rejected and the operation
must be reconciled with `status` or `resume`.

`resume` must reconcile every known transaction hash before retrying and must
never repeat a fund-moving transaction whose outcome is unknown.
