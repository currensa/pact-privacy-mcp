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

## Command reference

The tables below describe the purpose of each command. Detailed examples follow.

| Command | Description |
| --- | --- |
| `init` | Interactively generate or import a wallet, initialize account encryption data, obtain an API key, and write a protected `.env`. |
| `status` | Check local configuration, backend connectivity, account initialization, and API-key grants without displaying credentials. |
| `rotate-api-key` | Revoke and replace the API key stored in the local environment file. |
| `chain list` | List supported chains and their EVM or TRON family. |
| `token list` | List configured tokens for one chain. |
| `receiver list` | Find registered recipients whose public account data can receive private deposits. |
| `address show` | Display the EVM or TRON addresses derived from the configured private key. |
| `balance list` | Show native and configured-token balances for an address. |
| `balance get` | Read one native or token balance. |
| `allowance get` | Read an ERC-20 or TRC-20 allowance. |
| `transaction status` | Check whether a transaction is pending, confirmed, failed, or unavailable. |
| `deposit list` | List deposits already submitted and indexed for the local account; this does not list prepared operations. |
| `allocation list` | Decrypt and list incoming receiver allocations. An allocation ID identifies one encrypted receiver message and is used by withdrawal commands. |
| `token approve` | Approve a configured contract to spend a token after confirmation. |
| `transfer native` | Transfer the chain's native currency after confirmation. |
| `transfer token` | Transfer an ERC-20 or TRC-20 token after confirmation. |

Private workflows use an immutable preparation followed by explicit execution:

| Command | Description | Availability |
| --- | --- | --- |
| `deposit prepare` | Validate recipients, amounts, balances, allowance, circuit tier, and optional refund support without moving funds. | Available |
| `deposit execute` | Revalidate the plan, generate the proof and ciphertext locally, submit transactions, and deliver indexed backend records. | Available |
| `withdraw prepare` | Select and decrypt one allocation, validate its remaining on-chain amount, and prepare a partial or full withdrawal. | Available |
| `withdraw execute` | Refresh claimed state and membership data, generate the proof locally, and submit the withdrawal. | Available |
| `refund prepare` | Select an owned refundable deposit and calculate its current refundable result. | Available |
| `refund execute` | Generate and submit the refund proof, then update the backend after confirmation. | Available |

| Recovery command | Description |
| --- | --- |
| `operation list` | List locally persisted preparations and executions, optionally only incomplete ones. |
| `operation status` | Display the immutable plan, progress stage, and safe transaction metadata for one operation. |
| `operation cancel` | Cancel a preparation only before any transaction has been registered. |
| `operation resume` | Reconcile known transaction hashes and safely continue an interrupted operation without blindly repeating a payment. |

## Parameter reference

Common and administrative parameters:

| Parameter | Used by | Meaning |
| --- | --- | --- |
| `--env <path>` | Most commands | Protected environment file to read or update. Defaults to `./.env`. |
| `--chain <chain-id>` | Chain-specific commands | Numeric chain ID from `chain list`, such as `11142220`; it is not a family or network name. |
| `--family <family>` | `init`, `receiver list`, `address show` | `evm` or `tron`; `init` also accepts `both`. |
| `--backend <url>` | `init` | Pact Privacy backend API URL written to the environment file. |
| `--replace` | `init` | Permit replacement of existing managed account configuration after confirmation. |
| `--confirm` | Write and execute commands | Skip the interactive confirmation. Validation and transaction-safety checks still run. |

Discovery and basic Web3 parameters:

| Parameter | Used by | Meaning |
| --- | --- | --- |
| `--token <token>` | Token, balance, allowance, deposit, and transfer commands | Configured token symbol or token contract address. `balance get` also accepts `native`. |
| `--address <address>` | Receiver, balance, and allowance commands | Address to filter or inspect. Balance and allowance commands default to the local signer. |
| `--spender <spender>` | Allowance and approval commands | Configured spender name such as `gravarc`, or a contract address. |
| `--amount <amount>` | Approval, transfer, and withdraw commands | Human-readable decimal token amount, not base units. Token approval also accepts `unlimited`. |
| `--to <address>` | Transfer commands | Public recipient address in the selected chain family. |
| `--hash <hash>` | `transaction status` | EVM transaction hash or TRON transaction ID. |
| `--leaf-index <index>` | `deposit list`, `refund prepare` | Non-negative deposit leaf index assigned by the on-chain deposit tree. |
| `--unwithdrawn` | `allocation list` | Return only allocations with a positive remaining amount that have not been refunded. |

Private-workflow parameters:

| Parameter | Used by | Meaning |
| --- | --- | --- |
| `--receiver <address:amount>` | `deposit prepare` | One registered receiver and human-readable amount. Repeat the option for multiple receivers. |
| `--receivers <csv-path>` | `deposit prepare` | Payroll CSV containing `address,amount` columns; rows are combined with repeated `--receiver` options. |
| `--refund` | Deposit and private-redeposit preparation | Include encrypted depositor data required for a later refund. It does not execute a refund. |
| `--allocation <id>` | `withdraw prepare` | Backend message ID returned by `allocation list`. It selects one encrypted receiver allocation without exposing its nullifier. |
| `--all` | `withdraw prepare` | Withdraw the allocation's full current remaining amount. It cannot be combined with `--amount`. |
| `<operation-id>` | Execute, status, cancel, and resume commands | Local durable ID returned by a preparation, such as `op_01J...`. It is not a transaction hash. |

Recovery filtering:

| Parameter | Meaning |
| --- | --- |
| `--incomplete` | Limit `operation list` to operations that still require execution or reconciliation. |

## Completed commands

> **Note:** The examples below use `pactpay`. If the package is not installed
> globally, run the equivalent development command by replacing `pactpay` with
> `npm run cli --`, for example `npm run cli -- chain list`.
>
> To install the current local project globally, run these commands from the
> project directory:
>
> ```bash
> npm run build
> npm install -g .
> ```
>
> After the package is published to npm, install it with
> `npm install -g pact-privacy-mcp`. Both methods provide the `pactpay` command.

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

## Future work

The commands in this section are designs only and are not implemented.

### Milestone 1: Relayed withdrawal and refund

The existing direct deposit, withdrawal, and refund commands continue to sign
and submit transactions with the local private key.

#### Relayed withdrawal

```bash
pactpay relayed-withdraw prepare --chain 11142220 --allocation 735 \
  --amount 250.00 --recipient 0xReceiver... --fee 0.25 \
  --relayer https://relayer.example
pactpay relayed-withdraw execute op_01J... --confirm
pactpay relayed-withdraw status op_01J...
```

`--recipient` is the public address receiving the withdrawal after the fee.
`--fee` is a human-readable token amount paid to the relayer and must satisfy
the contract minimum. The proof must bind the recipient, quoted relayer
address, and accepted fee.

#### Relayed refund

```bash
pactpay relayed-refund prepare --chain 11142220 --leaf-index 42 \
  --refunder 0xDepositor... --fee 0.50 \
  --relayer https://relayer.example
pactpay relayed-refund execute op_01J... --confirm
pactpay relayed-refund status op_01J...
```

The proof must bind the public refunder address, quoted relayer address, and
fee. Execution must refresh every related claimed and refunded state before
generating the proof.

### Milestone 2: DeFi and relayed DeFi

DeFi will be EVM-only. Preparation will quote the protocol call and support a
public output or a private redeposit:

```bash
pactpay defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol uniswap-v3 --output-token USDC --min-output 99.00 \
  --to 0xReceiver...

pactpay defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol uniswap-v3 --output-token USDC --min-output 99.00 \
  --receiver 0xAlice...:60.00 --receiver 0xBob...:39.00 \
  --private-redeposit --refund
pactpay defi execute op_01J... --confirm
```

Its additional parameters will be `--protocol`, `--output-token`,
`--min-output`, and `--private-redeposit`. Attempting it on TRON must fail
before quoting or proof generation.

#### Relayed DeFi

Relayed DeFi remains EVM-only and keeps the normal DeFi routing parameters:

```bash
pactpay relayed-defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol uniswap-v3 --output-token USDC --min-output 99.00 \
  --to 0xReceiver... --fee 0.25 --relayer https://relayer.example
pactpay relayed-defi execute op_01J... --confirm
pactpay relayed-defi status op_01J...
```

Here `--fee` is the transaction relayer compensation included in the committed
DeFi router data. Private redeposit should also support the normal repeatable
`--receiver`, `--private-redeposit`, and `--refund` options.

For all three relayed workflows, preparation should obtain a short-lived quote with the
relayer's submitting address, fee, expiry, and supported chain. Execution should
refresh mutable state, generate the proof locally, and send only the proof and
public operation parameters to the relayer. The relayer must verify the proof
and quote, sign and submit the transaction, and return its hash. Account secrets,
nullifiers, private keys, and proof witnesses must never be sent. Durable status,
quote expiry, and idempotency must prevent stale or duplicate submission.
