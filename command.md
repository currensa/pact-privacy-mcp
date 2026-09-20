# Pact Privacy CLI examples

After installing the published package globally, run commands with
`pactpay <command>`. During development, the equivalent source command is
`npm run cli -- <command>`.

Examples use Celo Sepolia (`11142220`) and TRON Nile (`3448148188`). Token
symbols are resolved from the selected chain configuration; an address may be
used instead when symbols are ambiguous. Commands that need the account
password read it from the protected profile or standalone `.env`, or prompt
for it without echoing.
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
| `account add` | Generate or import another account and save a protected local profile. |
| `account list` | List local accounts and the current default without displaying credentials. |
| `account show` | Show addresses and registered families for one account. |
| `account use` | Select the default account by EVM, canonical `0x`, or TRON address. |
| `account remove` | Remove local credentials only; backend data and operations remain. |
| `status` | Check local configuration, backend connectivity, account initialization, and API-key grants without displaying credentials. |
| `rotate-api-key` | Revoke and replace the API key stored in the selected account profile or standalone environment file. |
| `chain list` | List supported chains and their EVM or TRON family. |
| `token list` | List configured tokens for one chain. |
| `receiver list` | Find registered recipients whose public account data can receive private deposits. |
| `address show` | Display the EVM or TRON addresses derived from the configured private key. |
| `balance list` | Show native and configured-token balances for an address. |
| `balance get` | Read one native or token balance. |
| `allowance get` | Read an ERC-20 or TRC-20 allowance. |
| `transaction status` | Check whether a transaction is pending, confirmed, failed, or unavailable. |
| `relayer status` | Read relayer availability, supported chains/tokens/operations, addresses, and fee estimates. No account is required. |
| `deposit list` | List deposits already submitted and indexed for the local account; this does not list prepared operations. |
| `refund list` | Decrypt refund-enabled deposits locally and show their current allocated, withdrawn, and refundable amounts without creating an operation. |
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
| `relayed-withdraw prepare` | Validate an allocation, cache the circuit, obtain a relayer quote, and bind a recipient and maximum accepted fee. | Available |
| `relayed-withdraw execute` | Refresh state, generate proof-bound calldata locally, and submit it to the quoted relayer without using the local key for gas. | Available |
| `relayed-withdraw status` | Refresh the durable relayer operation and its transaction state. | Available |
| `refund prepare` | Select an owned refundable deposit and calculate its current refundable result. | Available |
| `refund execute` | Generate and submit the refund proof, then update the backend after confirmation. | Available |
| `relayed-refund prepare` | Refresh refundable state, cache the circuit, obtain a relayer quote, and bind the public refunder and fee limit. | Available |
| `relayed-refund execute` | Generate proof-bound calldata locally and submit it to the quoted relayer without using the local key for gas. | Available |
| `relayed-refund status` | Refresh the durable relayer operation and finish the backend refund update after confirmation. | Available |
| `defi quote` | Estimate protocol output and the recommended minimum without generating a proof or creating an operation. | Available |
| `defi prepare` | Quote a configured protocol and prepare a direct private withdrawal-to-DeFi operation. | Available |
| `defi execute` | Refresh the quote, generate the proof locally, and submit the committed DeFi calls. | Available |
| `relayed-defi quote` | Obtain an exact relayer fee quote, derive the swap input, and estimate protocol output without reading an allocation. | Available |
| `relayed-defi prepare` | Prepare DeFi calls and lock the external relayer's fee in a short-lived quote. | Available |
| `relayed-defi execute` | Generate proof-bound DeFi calldata locally and submit it to the quoted relayer. | Available |
| `relayed-defi status` | Refresh the durable relayed DeFi operation and any private re-deposit delivery. | Available |

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
| `--env <path>` | Most commands | Use a protected environment file as a standalone account override. |
| `--account <address>` | Most commands | Use one local account for this command. It overrides `PACT_PRIVACY_ACCOUNT` and the saved default. |
| `--chain <chain-id>` | Chain-specific commands | Numeric chain ID from `chain list`, such as `11142220`; it is not a family or network name. |
| `--family <family>` | `account add`, `receiver list`, `address show` | `evm` or `tron`; `account add` also accepts `both`. |
| `--backend <url>` | `account add` | Pact Privacy backend API URL saved in the shared local configuration. |
| `--confirm` | Write and execute commands | Skip the interactive confirmation. Validation and transaction-safety checks still run. |

Discovery and basic Web3 parameters:

| Parameter | Used by | Meaning |
| --- | --- | --- |
| `--token <token>` | Token, balance, allowance, deposit, and transfer commands | Configured token symbol or token contract address. `balance get` also accepts `native`. |
| `--address <address>` | Receiver, balance, and allowance commands | Address to filter or inspect. Balance and allowance commands default to the local signer. |
| `--spender <spender>` | Allowance and approval commands | Configured spender name such as `gravarc`, or a contract address. |
| `--amount <amount>` | Approval, transfer, withdraw, and direct DeFi commands | Human-readable decimal token amount, not base units. For direct DeFi it is the exact swap input. Token approval also accepts `unlimited`. |
| `--to <address>` | Transfer commands | Public recipient address in the selected chain family. |
| `--hash <hash>` | `transaction status` | EVM transaction hash or TRON transaction ID. |
| `--leaf-index <index>` | `deposit list`, `refund list`, `refund prepare`, `relayed-refund prepare` | Non-negative deposit leaf index assigned by the on-chain deposit tree. |
| `--unwithdrawn` | `allocation list` | Return only allocations with a positive remaining amount that have not been refunded. |

Private-workflow parameters:

| Parameter | Used by | Meaning |
| --- | --- | --- |
| `--receiver <address:amount>` | Deposit or private-redeposit preparation | One registered receiver and human-readable amount. Repeat the option for multiple receivers. |
| `--receivers <csv-path>` | Deposit or private-redeposit preparation | Payroll CSV containing `address,amount` columns; rows are combined with repeated `--receiver` options. |
| `--refund` | Deposit and private-redeposit preparation | Include encrypted depositor data required for a later refund. It does not execute a refund. |
| `--allocation <id>` | Withdraw or DeFi preparation | Backend message ID returned by `allocation list`. It selects one encrypted receiver allocation without exposing its nullifier. |
| `--all` | Withdrawal and direct DeFi preparation | Use the allocation's current remaining amount. Mutually exclusive with `--amount`. |
| `--input-token <token>` | DeFi quote | Configured input-token symbol or address; required because quotes do not read an allocation. |
| `--tier <tier>` | `relayed-defi quote` | Withdrawal circuit tier (`8`, `16`, `32`, `64`, or `128`) used to price relay execution. |
| `--redeposit-tier <tier>` | `relayed-defi quote` | Optional private re-deposit circuit tier used to include its additional gas. Omit it for public output; preparation derives it from receiver count. |
| `--withdraw-amount <amount>` | Relayed DeFi quote/preparation | Gross private withdrawal budget, including the relayer fee. |
| `--withdraw-all` | Relayed DeFi preparation | Use the allocation's full remaining amount as the gross budget; mutually exclusive with `--withdraw-amount`. |
| `--recipient <address>` | `withdraw prepare`, `relayed-withdraw prepare` | Public chain-family address that receives the withdrawn amount after the fee. Direct withdrawal defaults to the local signer. |
| `--refunder <address>` | `relayed-refund prepare` | Public chain-family address that receives the refund after the relayer fee. |
| `--max-fee <amount>` | Relayed quote/preparation | Optional maximum human-readable token fee. When omitted, the relayer's exact quoted fee is accepted. |
| `--relayer <url>` | Relayed quote/preparation and `relayer status` | HTTP(S) base URL of the selected relayer. |
| `--protocol <protocol>` | DeFi quote and preparation | Configured protocol name, type, or contract address. |
| `--output-token <token>` | DeFi quote and preparation | Configured output-token symbol or address. |
| `--min-output <amount>` | DeFi preparation | Minimum acceptable human-readable output amount; execution fails if a refreshed quote falls below it. |
| `--to <address>` | DeFi preparation | Public output recipient; mutually exclusive with `--private-redeposit`. |
| `--private-redeposit` | Direct and relayed DeFi preparation | Deposit output privately to the supplied receivers. This is available on EVM chains and unavailable on TRON. |
| `--excess-recipient <address>` | Variable-output private re-deposit | Public address that receives swap output above the fixed private re-deposit total. Required for Uniswap V3 private re-deposit. |
| `--slippage-bps <bps>` | DeFi quote and preparation | Quote slippage in basis points; defaults to 50 (0.5%). |
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

Create account profiles and choose a default by address:

```bash
pactpay account add
pactpay account add --family both
pactpay account add --family evm --backend https://privacy.pactpay.app/api
pactpay account list
pactpay account show 0xAccount...
pactpay account use TAccount...
pactpay --account 0xAnotherAccount... balance list --chain 11142220
```

Removing a profile requires confirmation and does not remove that account's
operation history or backend account.

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
pactpay withdraw prepare --chain 11142220 --allocation 735 --amount 250.00 \
  --recipient 0xReceiver...
pactpay withdraw prepare --chain 3448148188 --allocation 912 --all
pactpay withdraw execute op_01J... --confirm
```

The CLI decrypts locally, fetches a fresh membership path and claimed state,
and generates a fresh proof only during execution. For a direct withdrawal,
the local signer submits the transaction and receives the fee; `--recipient`
receives the net withdrawal and defaults to the signer when omitted.

## Relayed private withdrawal

Relayed withdrawal keeps the same local allocation and proof workflow, but the
quoted relayer pays the network fee and submits the transaction. Optional
`--max-fee` rejects quotes above the specified amount; when omitted, the exact
quoted fee is accepted. Preparation records that fee, the relayer address, and
the quote expiry:

```bash
pactpay relayed-withdraw prepare --chain 11142220 --allocation 735 \
  --amount 250.00 --recipient 0xReceiver... --max-fee 0.25 \
  --relayer http://150.109.25.172:9000
pactpay relayed-withdraw execute op_01J... --confirm
pactpay relayed-withdraw status op_01J...
```

Use `--all` instead of `--amount` for the full remaining allocation. Preparation
downloads and verifies the withdrawal circuit before obtaining the short-lived
quote. Execution refreshes claimed state and the membership path, generates the
proof locally, and sends only public `GravArc.withdraw` calldata. The private
key, password, allocation plaintext, nullifier, and proof witness are never sent
to the relayer.

If execution is interrupted after HTTP submission, rerun `relayed-withdraw
execute` or `operation resume`. The same stored calldata is submitted
idempotently; it is never regenerated as a replacement. Use `relayed-withdraw
status` until the relayer reports a confirmed or failed transaction.

## Refund

List every currently refundable deposit and its latest on-chain amount without
creating an operation. Optionally select one leaf:

```bash
pactpay refund list --chain 11142220
pactpay refund list --chain 11142220 --leaf-index 42
```

The result shows raw base-unit and human-readable allocated, withdrawn, and
refundable amounts. It does not expose ciphertext, nullifiers, secret hashes,
or refund entries.

Prepare the selected leaf, review the resulting operation, and execute:

```bash
pactpay refund prepare --chain 11142220 --leaf-index 42
pactpay operation status op_01J...
pactpay refund execute op_01J... --confirm
```

Preparation obtains all related withdrawal state. Execution decrypts refund
data and proves locally, submits the refund, and updates the backend only after
the transaction is confirmed. The same commands apply to TRON chains.

### Relayed refund

Inspect a relayer before preparing any relayed operation:

```bash
pactpay relayer status --relayer http://150.109.25.172:9000
```

The matching MCP tool is `relayer_status` with `relayerUrl`. Status returns fee
estimates; preparation still obtains an exact, short-lived quote. This query
requires no account credentials and creates no operation.

```bash
pactpay relayed-refund prepare --chain 11142220 --leaf-index 42 \
  --refunder 0xDepositor... --max-fee 0.50 \
  --relayer http://150.109.25.172:9000
pactpay relayed-refund execute op_01J... --confirm
pactpay relayed-refund status op_01J...
```

Preparation refreshes every related claimed/refunded state before obtaining a
short-lived quote. Execution generates proof-bound calldata locally. After the
relayer confirms the transaction, the CLI marks the backend deposition
refunded; `status` or `operation resume` safely retries only that update.

## Private DeFi

Use exactly one of `--amount` or `--all` for direct DeFi preparation. Direct
DeFi treats either value as the swap input. Relayed preparation instead uses
exactly one of `--withdraw-amount` or `--withdraw-all`; this is the gross private
withdrawal budget, from which the exact relayer fee is deducted before swapping.
Rounding may leave a tiny base-unit remainder. The relayer must support
gross-budget DeFi quotes. Preparation freezes the resolved amounts; execution
rechecks the allocation and does not increase them automatically.

Inspect the current output estimate before selecting `--min-output`. This is
read-only: it creates no operation, proof, relayer quote, or transaction:

```bash
pactpay defi quote --chain 11142220 --input-token USDC --amount 100.00 \
  --protocol mock-swap --output-token MCK
```

Direct DeFi withdraws one allocation into `PactPrivacyDefiRouter`, commits the
selected protocol calls in the withdrawal proof, and either sends the result
to a public recipient or privately re-deposits it:

```bash
pactpay defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol mock-swap --output-token MCK --min-output 99.00 \
  --to 0xReceiver...

pactpay defi prepare --chain 11142220 --allocation 735 --amount 100.00 \
  --protocol mock-swap --output-token MCK --min-output 100.00 \
  --receiver 0xAlice...:60.00 --receiver 0xBob...:40.00 \
  --private-redeposit --refund

pactpay defi execute op_01J... --confirm
```

On Ethereum Sepolia, Uniswap V3 supports ERC-20 pairs only. Use WETH rather
than native ETH. A variable-output private re-deposit fixes the privately
deposited amount and sends any additional swap output to the explicit excess
recipient:

```bash
pactpay defi quote --chain 11155111 --input-token USDC --amount 50 \
  --protocol uniswap-v3 --output-token WETH

pactpay defi prepare --chain 11155111 --allocation 736 --amount 50 \
  --protocol uniswap-v3 --output-token WETH --min-output 0.0013 \
  --to 0xReceiver...

pactpay defi prepare --chain 11155111 --allocation 736 --amount 50 \
  --protocol uniswap-v3 --output-token WETH --min-output 0.0013 \
  --receiver 0xReceiver...:0.0013 --private-redeposit \
  --excess-recipient 0xExcessReceiver...
```

TRON supports public-output DeFi, such as SunSwap V4, but intentionally rejects
`--private-redeposit` in both direct and relayed workflows:

```bash
pactpay defi prepare --chain 3448148188 --allocation 912 --amount 100 \
  --protocol sunswap-v4 --output-token USDT --min-output 9.5 \
  --to TReceiver...
```

Monad Testnet supports Kuru only through the configured one-hop MCK/MCK-2
market. Native MON, unknown markets, multihop routes, and Kuru Flow programs
are rejected. Both public output and EVM private re-deposit are available:

```bash
pactpay defi quote --chain 10143 --input-token MCK --amount 10 \
  --protocol kuru --output-token MCK-2

pactpay defi prepare --chain 10143 --allocation 913 --amount 10 \
  --protocol kuru --output-token MCK-2 --min-output 9.5 \
  --to 0xReceiver...

pactpay defi prepare --chain 10143 --allocation 913 --amount 10 \
  --protocol kuru --output-token MCK-2 --min-output 9.5 \
  --receiver 0xReceiver...:9.5 --private-redeposit \
  --excess-recipient 0xExcessReceiver...
```

Relayed quoting requests an exact, short-lived fee from the relayer, deducts it
from `--withdraw-amount`, and quotes the protocol using the resulting swap
input. It creates no local operation, proof, or transaction. The returned
recommended minimum can be reviewed before preparation:

```bash
pactpay relayed-defi quote --chain 11142220 --tier 8 \
  --input-token USDC --withdraw-amount 100.00 \
  --protocol mock-swap --output-token MCK \
  --relayer http://localhost:9000
```

Preparation repeats the short-lived quote and safely rejects a `--min-output`
that the refreshed protocol quote cannot satisfy. The fee is paid by
`PactPrivacyDefiRouter` only after the committed calls succeed. `--max-fee` is
optional:

```bash
pactpay relayed-defi prepare --chain 11142220 --allocation 735 --withdraw-amount 100.00 \
  --protocol mock-swap --output-token MCK --min-output 99.00 \
  --to 0xReceiver... --max-fee 0.25 --relayer http://localhost:9000
pactpay relayed-defi execute op_01J... --confirm
pactpay relayed-defi status op_01J...
```

Relayed DeFi also supports private re-deposit on EVM chains. For a
variable-output protocol, the receiver amounts define the fixed private
deposit and `--excess-recipient` receives any additional output. A standalone
quote uses `--redeposit-tier`; preparation derives the same tier automatically
from its receiver count:

```bash
pactpay relayed-defi quote --chain 11155111 --tier 8 --redeposit-tier 8 \
  --input-token USDC --withdraw-amount 50 \
  --protocol uniswap-v3 --output-token WETH \
  --relayer http://localhost:9000

pactpay relayed-defi prepare --chain 11155111 --allocation 736 \
  --withdraw-amount 50 --protocol uniswap-v3 --output-token WETH \
  --min-output 0.0013 --receiver 0xReceiver...:0.0013 \
  --private-redeposit --excess-recipient 0xExcessReceiver... \
  --relayer http://localhost:9000

pactpay relayed-defi execute op_01J... --confirm
```

## Recovery

Every prepared operation has durable, non-secret state. Check progress after a
timeout or restart, then resume proof generation, transaction reconciliation,
scanner indexing, or message delivery from the last safe stage:

```bash
pactpay operation status op_01J...
pactpay operation list --incomplete
pactpay operation list --all-accounts
pactpay operation cancel op_01J...
pactpay operation resume op_01J...
```

`cancel` marks an unexecuted preparation as cancelled so it cannot later be
executed or resumed. Preparations also expire automatically. Once any
transaction has been broadcast, cancellation is rejected and the operation
must be reconciled with `status` or `resume`.

`resume` must reconcile every known transaction hash before retrying and must
never repeat a fund-moving transaction whose outcome is unknown.
