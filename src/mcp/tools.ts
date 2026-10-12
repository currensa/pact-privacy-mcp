import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { McpAccountSelection } from "../accounts/mcp.js";
import { McpWorkflows } from "./workflows.js";
import { RefundDiscoveryService } from "../refund/list.js";
import { DepositExecutionService } from "../deposit/execute.js";
import { WithdrawExecutionService } from "../withdraw/execute.js";
import { RefundExecutionService } from "../refund/execute.js";
import { RelayedWithdrawPreparationService } from "../relayed-withdraw/prepare.js";
import { RelayedWithdrawExecutionService } from "../relayed-withdraw/execute.js";
import { RelayedRefundPreparationService } from "../relayed-refund/prepare.js";
import { RelayedRefundExecutionService } from "../relayed-refund/execute.js";
import { DefiPreparationService } from "../defi/prepare.js";
import { DefiExecutionService } from "../defi/execute.js";
import { DefiQuoteService } from "../defi/quote.js";
import { RelayedDefiPreparationService } from "../relayed-defi/prepare.js";
import { RelayedDefiExecutionService } from "../relayed-defi/execute.js";
import { RelayedDefiQuoteService } from "../relayed-defi/quote.js";
import { RelayerClient } from "../relayer/client.js";

type Shape = Record<string, z.ZodType>;
const resultSchema = z.object({ result: z.unknown() });
const accountField = z.string().optional().describe("Allowed local account; defaults to the MCP startup account");
const chainIdField = z.number().int().nonnegative();
const operationIdField = z.string().min(1);
const confirmationField = z.literal(true).describe("Must be true after the operation or transfer has been reviewed");

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as unknown;
}

function success(value: unknown) {
  const safe = jsonSafe(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
    structuredContent: { result: safe },
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "MCP workflow failed";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function registerWorkflowTools(server: McpServer, accounts: McpAccountSelection): void {
  const workflows = new McpWorkflows(accounts);
  const register = <T extends Shape>(
    name: string,
    description: string,
    shape: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
    readOnly = false,
  ) => {
    server.registerTool(name, {
      description,
      inputSchema: z.object(shape),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
    }, async (input) => {
      try {
        return success(await handler(input));
      } catch (error) {
        return failure(error);
      }
    });
  };

  register("list_accounts", "List local accounts allowed for this MCP server.", {},
    () => workflows.listAccounts(), true);

  register("relayer_status", "Read relayer availability, supported chains and operations, addresses, and estimated fees. Preparation still requires an exact quote.", {
    relayerUrl: z.string().url(),
  }, ({ relayerUrl }) => new RelayerClient(relayerUrl).status(), true);

  register("list_chains", "List Pact Privacy chains available to the local account.", { account: accountField },
    ({ account }) => workflows.run(account, async ({ client }) => workflows.discovery(client).chains()), true);

  register("list_organizations", "List organization IDs, membership status, and roles for the selected account.", { account: accountField },
    ({ account }) => workflows.run(account, async ({ client }) => workflows.discovery(client).organizations()), true);

  register("list_tokens", "List configured fungible tokens on a chain.", { account: accountField, chainId: chainIdField },
    ({ account, chainId }) => workflows.run(account, async ({ client }) => (await workflows.web3(client, chainId)).tokens()), true);

  register("list_receivers", "List active private-payment receivers in one organization.", {
    account: accountField,
    orgId: z.string().min(1),
    address: z.string().optional(),
  }, ({ account, orgId, address }) => workflows.run(account, async ({ client }) => (
    workflows.discovery(client).receivers(orgId, address)
  )), true);

  register("show_addresses", "Show addresses derived from the selected local account.", {
    account: accountField,
    family: z.enum(["evm", "tron"]).optional(),
  }, ({ account, family }) => workflows.run(account, async ({ client }) => workflows.addresses(client, family)), true);

  register("list_balances", "Read native and configured-token balances.", {
    account: accountField, chainId: chainIdField, address: z.string().optional(),
  }, ({ account, chainId, address }) => workflows.run(account, async ({ client }) => {
    const web3 = await workflows.web3(client, chainId);
    const native = await web3.nativeBalance(address);
    const tokens = await Promise.all(web3.chain.erc20Tokens.map((token) => web3.tokenBalance(token.address, address)));
    return { chainId, address: web3.normalizeAccount(address).display, native, tokens };
  }), true);

  register("get_balance", "Read one native or fungible-token balance.", {
    account: accountField, chainId: chainIdField, token: z.string().min(1), address: z.string().optional(),
  }, ({ account, chainId, token, address }) => workflows.run(account, async ({ client }) => {
    const web3 = await workflows.web3(client, chainId);
    return token.toLowerCase() === "native" ? web3.nativeBalance(address) : web3.tokenBalance(token, address);
  }), true);

  register("get_allowance", "Read a fungible-token allowance.", {
    account: accountField, chainId: chainIdField, token: z.string().min(1), spender: z.string().min(1), address: z.string().optional(),
  }, ({ account, chainId, token, spender, address }) => workflows.run(account, async ({ client }) => (
    (await workflows.web3(client, chainId)).allowance(token, spender, address)
  )), true);

  register("transaction_status", "Read an EVM or TRON transaction status.", {
    account: accountField, chainId: chainIdField, hash: z.string().min(1),
  }, ({ account, chainId, hash }) => workflows.run(account, async ({ client }) => (
    (await workflows.web3(client, chainId)).transactionStatus(hash)
  )), true);

  register("list_deposits", "List indexed deposits owned by the selected account without returning ciphertext.", {
    account: accountField, chainId: chainIdField, leafIndex: z.number().int().nonnegative().optional(),
  }, ({ account, chainId, leafIndex }) => workflows.run(account, async ({ client }) => {
    const rows = await workflows.discovery(client).depositions(chainId, leafIndex);
    return rows.map((row) => ({
      chainId, leafIndex: row.leaf_index, canRefund: row.can_refund === 1,
      refunded: row.is_refunded === true || row.is_refunded === 1, messageCount: row.message_count,
    }));
  }), true);

  register("list_allocations", "Decrypt and list incoming allocations with their current remaining amounts.", {
    account: accountField, chainId: chainIdField, unwithdrawnOnly: z.boolean().default(false),
  }, ({ account, chainId, unwithdrawnOnly }) => workflows.run(account, async ({ client, context }) => {
    if (!context.environment.password) throw new Error("The selected account has no local password");
    return workflows.discovery(client).allocations(chainId, context.environment.password, unwithdrawnOnly);
  }), true);

  register("list_refundable_deposits", "List refund-enabled deposits and current refundable amounts without creating operations.", {
    account: accountField, chainId: chainIdField, leafIndex: z.number().int().nonnegative().optional(),
  }, ({ account, chainId, leafIndex }) => workflows.run(account, async ({ client }) => (
    new RefundDiscoveryService(client).list({ chainId, ...(leafIndex === undefined ? {} : { leafIndex }) })
  )), true);

  register("approve_token", "Approve a fungible-token allowance. This immediately submits a public transaction.", {
    account: accountField, chainId: chainIdField, token: z.string().min(1), spender: z.string().min(1),
    amount: z.string().min(1), confirm: confirmationField,
  }, ({ account, chainId, token, spender, amount }) => workflows.run(account, async ({ client }) => (
    (await workflows.web3(client, chainId)).approve(token, spender, amount)
  )));

  register("transfer_native", "Transfer native currency. This immediately submits a public transaction.", {
    account: accountField, chainId: chainIdField, to: z.string().min(1), amount: z.string().min(1), confirm: confirmationField,
  }, ({ account, chainId, to, amount }) => workflows.run(account, async ({ client }) => (
    (await workflows.web3(client, chainId)).transferNative(to, amount)
  )));

  register("transfer_token", "Transfer a fungible token. This immediately submits a public transaction.", {
    account: accountField, chainId: chainIdField, token: z.string().min(1), to: z.string().min(1),
    amount: z.string().min(1), confirm: confirmationField,
  }, ({ account, chainId, token, to, amount }) => workflows.run(account, async ({ client }) => (
    (await workflows.web3(client, chainId)).transferToken(token, to, amount)
  )));

  register("prepare_deposit", "Validate and prepare a private deposit without moving funds.", {
    account: accountField, orgId: z.string().min(1), chainId: chainIdField, token: z.string().min(1),
    recipients: z.array(z.object({ address: z.string().min(1), amount: z.string().min(1) })).min(1),
    refund: z.boolean().default(false),
  }, ({ account, orgId, chainId, token, recipients, refund }) => workflows.run(account, async ({ client, operations }) => (
    workflows.prepareDeposit(client, operations, { orgId, chainId, token, recipients, refund })
  )));

  register("execute_deposit", "Execute a reviewed deposit operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => {
    const operation = await operations.get(operationId);
    if (operation.kind !== "deposit") throw new Error("Operation is not a deposit");
    return new DepositExecutionService(client, operations).execute(operationId);
  }));

  register("prepare_withdraw", "Prepare a partial or full private withdrawal without submitting it.", {
    account: accountField, chainId: chainIdField, allocationId: z.string().min(1),
    amount: z.string().min(1).optional(), all: z.boolean().default(false),
    recipient: z.string().min(1).optional().describe("Public recipient of the net withdrawal; defaults to the local signer."),
  }, ({ account, chainId, allocationId, amount, all, recipient }) => workflows.run(account, async ({ client, operations }) => (
    workflows.prepareWithdraw(client, operations, {
      chainId, allocationId, ...(amount ? { amount } : {}), all,
      ...(recipient === undefined ? {} : { recipient }),
    })
  )));

  register("execute_withdraw", "Execute a reviewed private withdrawal operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new WithdrawExecutionService(client, operations).execute(operationId)
  )));

  register("prepare_relayed_withdraw", "Prepare a relayer-submitted private withdrawal and obtain a quote.", {
    account: accountField, chainId: chainIdField, allocationId: z.string().min(1),
    amount: z.string().min(1).optional(), all: z.boolean().default(false), recipient: z.string().min(1),
    maximumFee: z.string().min(1).optional(), relayerUrl: z.string().url(),
  }, ({ account, chainId, allocationId, amount, all, recipient, maximumFee, relayerUrl }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedWithdrawPreparationService(client, operations).prepare({
      chainId, allocationId, all, recipient, relayerUrl,
      ...(amount === undefined ? {} : { amount }),
      ...(maximumFee === undefined ? {} : { maximumFee }),
    })
  )));

  register("execute_relayed_withdraw", "Execute a reviewed relayed-withdraw operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedWithdrawExecutionService(client, operations).execute(operationId)
  )));

  register("relayed_withdraw_status", "Refresh a relayed withdrawal operation.", {
    account: accountField, operationId: operationIdField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedWithdrawExecutionService(client, operations).status(operationId)
  )));

  register("prepare_refund", "Prepare a private refund for one deposit leaf.", {
    account: accountField, chainId: chainIdField, leafIndex: z.number().int().nonnegative(),
  }, ({ account, chainId, leafIndex }) => workflows.run(account, async ({ client, operations }) => (
    workflows.prepareRefund(client, operations, chainId, leafIndex)
  )));

  register("execute_refund", "Execute a reviewed private refund operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RefundExecutionService(client, operations).execute(operationId)
  )));

  register("prepare_relayed_refund", "Prepare a relayer-submitted refund and obtain a quote.", {
    account: accountField, chainId: chainIdField, leafIndex: z.number().int().nonnegative(), refunder: z.string().min(1),
    maximumFee: z.string().min(1).optional(), relayerUrl: z.string().url(),
  }, ({ account, chainId, leafIndex, refunder, maximumFee, relayerUrl }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedRefundPreparationService(client, operations).prepare({
      chainId, leafIndex, refunder, relayerUrl,
      ...(maximumFee === undefined ? {} : { maximumFee }),
    })
  )));

  register("execute_relayed_refund", "Execute a reviewed relayed-refund operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedRefundExecutionService(client, operations).execute(operationId)
  )));

  register("relayed_refund_status", "Refresh a relayed refund operation.", {
    account: accountField, operationId: operationIdField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedRefundExecutionService(client, operations).status(operationId)
  )));

  const defiQuoteFields = {
    account: accountField,
    chainId: chainIdField,
    inputToken: z.string().min(1),
    amount: z.string().min(1),
    protocol: z.string().min(1),
    outputToken: z.string().min(1),
    slippageBips: z.number().int().min(0).max(9_999).default(50),
  };

  register("quote_defi", "Estimate DeFi output for an explicit input token and amount without reading an allocation or preparing an operation.", defiQuoteFields,
    ({ account, ...input }) => workflows.run(account, async ({ client }) => new DefiQuoteService(client).quote(input)), true);

  const defiFields = {
    account: accountField,
    chainId: chainIdField,
    allocationId: z.string().min(1),
    amount: z.string().min(1).optional(),
    all: z.boolean().default(false).describe("Use the allocation's full remaining amount; mutually exclusive with amount."),
    protocol: z.string().min(1),
    outputToken: z.string().min(1),
    slippageBips: z.number().int().min(0).max(9_999).default(50),
    minimumOutput: z.string().min(1),
    destination: z.string().min(1).optional(),
    excessRecipient: z.string().min(1).optional().describe("Receives variable swap output above the private re-deposit total."),
    recipients: z.array(z.object({ address: z.string().min(1), amount: z.string().min(1) })).default([]),
    privateRedeposit: z.boolean().default(false).describe("Unavailable on TRON"),
    refund: z.boolean().default(false),
  };

  register("prepare_defi", "Quote and prepare a direct private DeFi operation without moving funds.", defiFields,
    ({ account, destination, excessRecipient, ...input }) => workflows.run(account, async ({ client, operations }) => (
      new DefiPreparationService(client, operations).prepare({
        ...input, ...(destination === undefined ? {} : { destination }),
        ...(excessRecipient === undefined ? {} : { excessRecipient }),
      })
    )));

  register("execute_defi", "Execute a reviewed direct DeFi operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new DefiExecutionService(client, operations).execute(operationId)
  )));

  register("quote_relayed_defi", "Obtain an exact relayer fee quote and estimate DeFi output from the resulting swap amount.", {
    account: accountField,
    chainId: chainIdField,
    tier: z.union([z.literal(8), z.literal(16), z.literal(32), z.literal(64), z.literal(128)]),
    redepositTier: z.union([z.literal(8), z.literal(16), z.literal(32), z.literal(64), z.literal(128)]).optional()
      .describe("Private re-deposit circuit tier; omit for public output."),
    inputToken: z.string().min(1),
    outputToken: z.string().min(1),
    protocol: z.string().min(1),
    withdrawalAmount: z.string().min(1).describe("Gross amount including the relayer fee."),
    maximumFee: z.string().min(1).optional(),
    relayerUrl: z.string().url(),
    slippageBips: z.number().int().min(0).max(9_999).default(50),
  }, ({ account, maximumFee, redepositTier, ...input }) => workflows.run(account, async ({ client }) => (
    new RelayedDefiQuoteService(client).quote({
      ...input,
      ...(maximumFee === undefined ? {} : { maximumFee }),
      ...(redepositTier === undefined ? {} : { redepositTier }),
    })
  )), true);

  register("prepare_relayed_defi", "Quote and prepare a relayer-submitted DeFi operation without moving funds.", {
    account: accountField,
    chainId: chainIdField,
    allocationId: z.string().min(1),
    withdrawalAmount: z.string().min(1).optional().describe("Gross allocation amount including the relayer fee."),
    withdrawAll: z.boolean().default(false).describe("Use the allocation's full remaining amount including the relayer fee."),
    protocol: z.string().min(1),
    outputToken: z.string().min(1),
    slippageBips: z.number().int().min(0).max(9_999).default(50),
    minimumOutput: z.string().min(1),
    destination: z.string().min(1).optional(),
    excessRecipient: z.string().min(1).optional().describe("Receives variable swap output above the private re-deposit total."),
    recipients: z.array(z.object({ address: z.string().min(1), amount: z.string().min(1) })).default([]),
    privateRedeposit: z.boolean().default(false).describe("Unavailable on TRON"),
    refund: z.boolean().default(false),
    maximumFee: z.string().min(1).optional(),
    relayerUrl: z.string().url(),
  }, ({ account, maximumFee, destination, excessRecipient, withdrawalAmount, ...input }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedDefiPreparationService(client, operations).prepare({
      ...input, ...(withdrawalAmount === undefined ? {} : { withdrawalAmount }),
      ...(destination === undefined ? {} : { destination }),
      ...(excessRecipient === undefined ? {} : { excessRecipient }),
      ...(maximumFee === undefined ? {} : { maximumFee }),
    })
  )));

  register("execute_relayed_defi", "Execute a reviewed relayed DeFi operation.", {
    account: accountField, operationId: operationIdField, confirm: confirmationField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedDefiExecutionService(client, operations).execute(operationId)
  )));

  register("relayed_defi_status", "Refresh a relayed DeFi operation.", {
    account: accountField, operationId: operationIdField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    new RelayedDefiExecutionService(client, operations).status(operationId)
  )));

  register("list_operations", "List durable local operations for one allowed account.", {
    account: accountField, incompleteOnly: z.boolean().default(false),
  }, ({ account, incompleteOnly }) => workflows.run(account, async ({ operations }) => operations.list(incompleteOnly)), true);

  register("operation_status", "Read one durable operation without advancing it.", {
    account: accountField, operationId: operationIdField,
  }, ({ account, operationId }) => workflows.run(account, async ({ operations }) => operations.get(operationId)), true);

  register("cancel_operation", "Cancel a prepared operation that has no registered transaction.", {
    account: accountField, operationId: operationIdField,
  }, ({ account, operationId }) => workflows.run(account, async ({ operations }) => operations.cancel(operationId)));

  register("resume_operation", "Safely reconcile and resume a previously confirmed operation.", {
    account: accountField, operationId: operationIdField,
  }, ({ account, operationId }) => workflows.run(account, async ({ client, operations }) => (
    workflows.resume(client, operations, operationId)
  )));
}
