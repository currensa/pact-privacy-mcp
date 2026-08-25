# PactPay MCP Server

PactPay MCP server for browser-based, session-token, or API-key authentication, organization and plan queries, balance checks, plan creation, and API key management.

Package:

- `@pactpay/mcp-server`

Defaults:

- API: `https://pactpay.app`
- Web: `https://pactpay.app`

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `PACTPAY_BASE_URL` | No | PactPay API base URL. Defaults to `https://pactpay.app`. |
| `PACTPAY_TOKEN` | No | Pre-authenticate with a PactPay session token. Sent as `Authorization: Bearer <token>`. |
| `PACTPAY_API_KEY` | No | Pre-authenticate with a PactPay organization API key. Sent as `x-api-key`. Takes effect only when `PACTPAY_TOKEN` is not set. |
| `PACTPAY_ORG_ID` | No | Pin the current organization context at startup. When omitted, the first manageable organization is selected automatically. |
| `WALLET_PRIVATE_KEY` | No | Funded EVM private key (with or without `0x` prefix) used to sign on-chain privacy deposit/refund/withdraw transactions locally, and to sign the nonce that obtains the `walletToken` required by `my-payroll-items`. The key's address must match the wallet address bound to your PactPay account. Required for `execute_privacy_deposit`, `relay_privacy_refund`, `relay_privacy_withdraw`, and `list_my_payroll_items`. Never leaves the process. |
| `PACTPAY_SIGNER_PASSWORD` | No | The PactPay account password used (with `WALLET_PRIVATE_KEY`) to derive the NaCl key that decrypts your GravArc account secret and encrypted withdraw/refund messages. Must match the password set when binding the GravArc wallet in the PactPay web app. |

Notes:

- `PACTPAY_TOKEN` and `PACTPAY_API_KEY` are mutually exclusive; the session token wins if both are set. When neither is set, browser-based auth is used.
- The API key must carry the required MCP scopes: `mcp:read` for queries, `mcp:write` for create/update/delete operations.
- No configuration is required for email login or auth callback port.
- Privacy payment tools come in two auth flavors:
  - **Admin side** (`create_privacy_deposit_plan`, `get_privacy_deposit_data`, `execute_privacy_deposit`, `relay_privacy_refund`, `get_privacy_withdraw_relayer`, `list_payment_chains`) accept either a session token or an org API key with `mcp:read`/`mcp:write` scopes.
  - **Employee side** (`list_my_payroll_items`, `get_my_payroll_summary`, `relay_privacy_withdraw`, `confirm_withdraw`) are "your own data" endpoints and require a **session token** (`PACTPAY_TOKEN`) — they cannot be accessed with an org API key.
- The first call to a privacy proof tool downloads the circuit `wasm`/`zkey` files (tens of MB) and caches them in memory for the session; proof generation itself takes tens of seconds and runs entirely on this machine.

## Two kinds of API key (do not confuse)

This MCP involves two unrelated things both called "API key":

1. **MCP login credential** (`set_api_key` / `PACTPAY_API_KEY`): the PactPay organization key used to authenticate THIS MCP server to PactPay (sent as `x-api-key`, needs `mcp` scopes). It is obtained from the PactPay console and is only for logging in.
2. **Plan key** (`create_plan_key`, `list_api_keys`, `update_api_key`, `delete_api_key`, `set_api_key_status`, `get_key_test_command`): the LLM gateway keys managed under a token usage plan. These are the keys end users/programs use to actually call models, and are managed as objects via this MCP.

A plan key cannot log in to this MCP, and an MCP login key cannot call the LLM gateway.

## Install

```bash
npx -y @pactpay/mcp-server
```

Or:

```bash
npm i -g @pactpay/mcp-server
pactpay-mcp-server
```

## Configuration

### Codex CLI

`~/.codex/config.toml`

```toml
[mcp_servers.pactpay]
command = "npx"
args = ["-y", "@pactpay/mcp-server"]
startup_timeout_sec = 60
```

With custom endpoints:

```toml
[mcp_servers.pactpay]
command = "npx"
args = ["-y", "@pactpay/mcp-server"]
startup_timeout_sec = 60

[mcp_servers.pactpay.env]
PACTPAY_BASE_URL = "https://pactpay.app"d
```

With an API key (headless / no browser):

```toml
[mcp_servers.pactpay.env]
PACTPAY_API_KEY = "pp-xxxxxxxx"
PACTPAY_ORG_ID = "org-xxxxxxxx"   # optional
```

### Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "pactpay": {
      "command": "npx",
      "args": ["-y", "@pactpay/mcp-server"],
      "env": {
        "PACTPAY_API_KEY": "pp-xxxxxxxx"
      }
    }
  }
}
```

### VS Code / Copilot

`.vscode/mcp.json`

```json
{
  "servers": {
    "pactpay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pactpay/mcp-server"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add pactpay --scope project -- npx -y @pactpay/mcp-server
```

## Authentication

Three mutually exclusive methods, in order of precedence:

### 1. Environment variables (headless)

Set `PACTPAY_TOKEN` or `PACTPAY_API_KEY` (see [Environment Variables](#environment-variables)). The server authenticates immediately at startup - no browser needed.

### 2. MCP tools (in-session)

- Call `set_token` with a session token, or `set_api_key` with an API key.
- Call `clear_auth` to remove stored credentials and fall back to browser auth.
- `get_auth_url` reports whether the server is currently authenticated and by which method.

### 3. Browser flow (interactive)

1. Start the MCP server.
2. Call `get_auth_url`, `open_auth_browser`, or any protected tool.
3. The server opens the browser to the PactPay auth page.
4. If the browser already has an active PactPay session, authorization completes automatically.
5. If not, sign in and the token is returned to the local MCP server automatically.
6. The server automatically selects the first manageable organization as the default context.

## Tools

### Authentication

- `open_auth_browser` - open the PactPay auth page in the default browser and return the auth/callback URLs.
- `get_auth_url` - get the front-end auth URL, callback URL, session id, and whether the server is already authenticated.
- `set_token` - authenticate with a PactPay session token (`Authorization: Bearer`).
  - `token` (string, required) - session token.
  - `orgId` (string, optional) - organization to pin as current context.
- `set_api_key` - log in to this MCP with a PactPay organization API key (`x-api-key` header). The key must have `mcp:read` and, for write operations, `mcp:write` scopes. This is the MCP login credential, NOT a plan key.
  - `apiKey` (string, required) - PactPay API key.
  - `orgId` (string, optional) - organization to pin as current context; resolved automatically when omitted.
- `clear_auth` - clear stored credentials (token or API key) and reset auth state.

### Organizations

- `list_manageable_orgs` - list organizations the current account can manage (admin/operator/owner only), with roles and member count.
- `get_current_org` - get current organization context and organization detail.
- `switch_org` - switch current organization context by organization id. Only manageable organizations are allowed.
  - `orgId` (string, required).
- `switch_org_by_name` - switch current organization context by name (exact match first, then case-insensitive partial).
  - `orgName` (string, required).

### Token usage plans

- `list_plans` - list plans under the current organization.
  - `page` (number, optional, default `1`), `pageSize` (number, optional, default `100`).
- `list_plans_with_balance` - list all plans under the current organization with computed balance for each.
- `find_plan_by_name` - find plans by name (exact match first, then case-insensitive partial).
  - `planName` (string, required).
- `create_plan` - create a new token usage plan under the current organization. Maps to `POST /api/orgs/:orgId/token-usage-plans`.
  - `planName` (string, required) - plan name.
  - `budget` (string, optional, default `"0"`) - spending cap in USD (number string). This is the budget cap, not the spendable balance; spendable balance is funded by separate recharges.
- `update_plan` - update a plan's name and/or budget cap. Maps to `PUT /api/orgs/:orgId/token-usage-plans/:id`. Only provided fields are changed; at least one of `planName` or `budget` must be supplied.
  - `planId` (string, required), `planName` (string, optional), `budget` (string, optional).
- `get_plan_detail` - get plan detail and profile.
  - `planId` (string, required).
- `get_plan_balance` - get plan budget, remaining quota, used quota, and derived balance numbers.
  - `planId` (string, required).
- `get_plan_profile` - get the forwarded NewAPI user self profile for a plan.
  - `planId` (string, required).
- `get_plan_groups` - get model groups available to a plan.
  - `planId` (string, required).
- `get_plan_models` - get models available to a plan.
  - `planId` (string, required).
- `list_all_plans_across_manageable_orgs` - list plans across all manageable organizations with computed balance.

### Plan API keys (LLM gateway keys)

Keys that plans use to call the LLM gateway - managed objects, distinct from the MCP login credential above (see [Two kinds of API key](#two-kinds-of-api-key-do-not-confuse)).

- `list_api_keys` - list API keys under a plan.
  - `planId` (string, required), `page` / `pageSize` (number, optional), `includeSecret` (boolean, optional, default `false`) - load the full key secret for each key.
- `list_all_keys_in_current_org` - list keys across all plans in the current organization.
  - `includeSecret` (boolean, optional, default `false`).
- `list_all_keys_across_manageable_orgs` - list keys across all manageable organizations and all plans.
  - `includeSecret` (boolean, optional, default `false`).
- `create_plan_key` - create a new API key for a plan. Returns the secret key.
  - `planId` (string, required), `name` (string, required).
  - `unlimitedQuota` (boolean, optional, default `true`), `remainAmount` (string, required when `unlimitedQuota=false`) - quota in USD string.
  - `expiredTime` (number, optional, default `-1` = never expires) - UTC+8 timestamp in seconds.
  - `group` (string, optional, default `default`), `allowIps` (string, optional), `crossGroupRetry` (boolean, optional, default `false`), `modelLimits` (string[], optional) - allowed model names.
- `update_api_key` - update an API key. Maps to `PUT /api/orgs/:orgId/token-usage-plans/:planId/api-keys/:apiKeyId`. Only provided fields are changed; at least one optional field must be supplied.
  - `planId`, `apiKeyId` (string, required); same optional fields as `create_plan_key` (`name`, `group`, `unlimitedQuota`, `remainAmount`, `expiredTime`, `allowIps`, `crossGroupRetry`, `modelLimits` - pass `[]` to clear model limits).
- `delete_api_key` - delete an API key. Maps to `DELETE /api/orgs/:orgId/token-usage-plans/:planId/api-keys/:apiKeyId`.
  - `planId`, `apiKeyId` (string, required).
- `set_api_key_status` - enable or disable an API key. Maps to `PUT /api/orgs/:orgId/token-usage-plans/:planId/api-keys/:apiKeyId/status`.
  - `planId`, `apiKeyId` (string, required), `status` (number, required) - `1` = enabled/active, `2` = disabled.
- `get_key_test_command` - get a ready-to-use test command and authorization header for one key.
  - `planId`, `apiKeyId` (string, required).

### Usage

- `get_plan_usage_logs` - get usage logs for a plan.
  - `planId` (string, required); optional filters: `page`, `pageSize`, `type`, `tokenName`, `modelName`, `startTime`, `endTime`, `channel`, `group`, `requestId`.
- `get_plan_usage_statistics` - get aggregated usage statistics for a plan. Same parameters as `get_plan_usage_logs`.

### Compatibility aliases

The following aliases map to the canonical tools above and can be used interchangeably:

- Organizations: `list_organizations`, `list_orgs`, `get_current_organization`, `switch_organization`, `switch_organization_by_name`
- Plans: `list_token_usage_plans`, `list_usage_plans`, `list_token_usage_plans_with_balance`, `find_token_usage_plan_by_name`, `create_token_usage_plan`, `create_usage_plan`, `update_token_usage_plan`, `get_token_usage_plan_detail`, `get_token_usage_plan_balance`, `get_token_usage_plan_profile`, `get_groups`, `get_models`, `list_all_usage_plans_across_manageable_orgs`
- Keys: `list_keys`, `get_api_keys`, `list_api_keys_in_plan`, `list_keys_in_plan`, `list_keys_in_current_org`, `list_api_keys_in_current_org`, `list_all_api_keys_in_current_org`, `list_all_api_keys_across_manageable_orgs`, `list_keys_across_manageable_orgs`, `get_api_key_test_command`, `create_api_key`, `create_key`, `update_key`, `delete_key`, `update_api_key_status`, `set_key_status`
- Usage: `get_usage_logs`, `get_plan_logs`, `get_usage_statistics`, `get_plan_statistics`

## Privacy payments (GravArc deposit / withdraw / refund)

This MCP can also perform GravArc privacy payments end-to-end. ZK proofs are generated locally (the circuit `wasm`/`zkey` are fetched from PactPay and cached in memory), and on-chain transactions are signed with `WALLET_PRIVATE_KEY`. Set `WALLET_PRIVATE_KEY` (funded, address matching the wallet bound to your account) and `PACTPAY_SIGNER_PASSWORD` (the account password used when binding the GravArc wallet in the web app). `list_my_payroll_items` also signs a nonce with `WALLET_PRIVATE_KEY` to obtain the `walletToken` that the backend requires.

| Tool | Side | What it does |
| --- | --- | --- |
| `list_payment_chains` | admin | List chains available for privacy payments (CAIP id, RPC). |
| `create_privacy_deposit_plan` | admin | Create a privacy deposit batch (members + amounts). Returns `batchId`. |
| `get_privacy_deposit_data` | admin | Fetch tier / per-member GravArc info / total amount for a batch. |
| `get_privacy_withdraw_relayer` | admin | Get the platform relayer address and per-chain relayer support flags. |
| `execute_privacy_deposit` | admin | Generate the deposit proof, approve + deposit on-chain, upload encrypted withdraw messages + refund payload. |
| `relay_privacy_refund` | admin | Decrypt the refund payload + depositor secret, generate the refund proof, submit via the platform relayer. |
| `list_my_payroll_items` | employee | List your own payroll items (with encrypted withdraw data). Requires `PACTPAY_TOKEN`. |
| `get_my_payroll_summary` | employee | Summarize claimed/pending payroll across organizations. Requires `PACTPAY_TOKEN`. |
| `relay_privacy_withdraw` | employee | Withdraw one of your items to a recipient via the platform relayer (you pay no gas). Requires `PACTPAY_TOKEN`. |
| `confirm_withdraw` | employee | Confirm a self-broadcast withdraw by tx hash. Requires `PACTPAY_TOKEN`. |

Typical admin flow: `create_privacy_deposit_plan` → `execute_privacy_deposit` (returns the deposit tx hash). Refund later with `relay_privacy_refund`. Typical employee flow: `list_my_payroll_items` → `relay_privacy_withdraw`.

## Development

```bash
npm run build    # compile to dist/
npm run dev      # run from source with auto-restart
```
