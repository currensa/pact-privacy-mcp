import type { PactPayClient } from './client.js';
import { PactPayPaymentService, type PaymentEnv } from './payment/service.js';

export function createPaymentTools(client: PactPayClient, env: PaymentEnv) {
    const service = new PactPayPaymentService(client, env);

    const definitions = [
        {
            name: 'list_payment_chains',
            description:
                'List blockchain chains available for PactPay payments, with CAIP chain id, name, and RPC endpoints. Use these when creating privacy deposit plans.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
            name: 'create_privacy_deposit_plan',
            description:
                'Create a GravArc privacy deposit batch under the current organization (maps to POST /api/transaction/:orgId/privacy-deposit-plan). Each member must have a bound GravArc wallet. Returns batchId, tier, and per-member GravArc info. Follow up with execute_privacy_deposit. caipChainId/tokenAddress are optional: omit both to auto-resolve from the organization\'s bound payroll config; provide them (e.g. resolved from list_payment_tokens) to pay in a specific chain/token.',
            inputSchema: {
                type: 'object',
                properties: {
                    caipChainId: { type: 'string', description: 'Optional CAIP-2 chain id, e.g. eip155:11155111. Omit to use the org\'s bound payroll config.' },
                    tokenAddress: { type: 'string', description: 'Optional ERC-20 token address, or the zero address for the native token. Omit to use the org\'s bound payroll config.' },
                    transactionName: { type: 'string', description: 'Optional batch name.' },
                    members: {
                        type: 'array',
                        description: 'Receivers; amount is a human-readable decimal string (e.g. "1.5").',
                        items: {
                            type: 'object',
                            properties: {
                                memberId: { type: 'string', description: 'Organization member id (from list_org_members).' },
                                amount: { type: 'string', description: 'Amount in token units, e.g. "100.5".' },
                            },
                            required: ['memberId', 'amount'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['members'],
                additionalProperties: false,
            },
        },
        {
            name: 'get_org_payroll_config',
            description:
                'Get the current organization\'s bound payroll config (maps to GET /api/orgs/:orgId/payroll-config): the default caipChainId and token contract address used when create_privacy_deposit_plan omits them. Requires admin (Owner/Admin/Operator) auth.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
            name: 'list_payment_tokens',
            description:
                'List supported payment tokens (maps to the public GET /api/chain-asset). Returns each token\'s symbol (e.g. USDC, USDT, ETH), contract address (null for native), decimals, isNative, isStable, chainName and caipChainId. Pass caipChainId to filter to one chain. Use this to resolve a token symbol like "USDC on Sepolia" to its contract address before calling create_privacy_deposit_plan.',
            inputSchema: {
                type: 'object',
                properties: {
                    caipChainId: { type: 'string', description: 'Optional CAIP-2 chain id to filter tokens to one chain, e.g. eip155:11155111.' },
                },
                additionalProperties: false,
            },
        },
        {
            name: 'get_privacy_deposit_data',
            description:
                'Fetch deposit data for a privacy deposit batch: tier, status, total amount, and each member\'s GravArc secretHash/encPubkey/platformFee (maps to GET /api/transaction/:orgId/batches/:batchId/privacy-deposit-data).',
            inputSchema: {
                type: 'object',
                properties: { batchId: { type: 'string', description: 'Batch id from create_privacy_deposit_plan.' } },
                required: ['batchId'],
                additionalProperties: false,
            },
        },
        {
            name: 'get_privacy_withdraw_relayer',
            description:
                'Get the platform relayer address and per-chain relayer support flags for privacy withdraw/refund (maps to GET /api/transaction/privacy-withdraw-relayer).',
            inputSchema: {
                type: 'object',
                properties: { caipChainId: { type: 'string', description: 'Optional CAIP-2 chain id to scope the support flags.' } },
                additionalProperties: false,
            },
        },
        {
            name: 'execute_privacy_deposit',
            description:
                'Execute a confirmed privacy deposit plan end-to-end: generate the deposit ZK proof locally, approve + deposit on-chain with the WALLET_PRIVATE_KEY wallet, then upload the encrypted per-receiver withdraw messages and refund payload to the backend. Requires WALLET_PRIVATE_KEY (funded) and, for refundable deposits, a bound GravArc account (PACTPAY_SIGNER_PASSWORD). On-chain proof generation can take tens of seconds.',
            inputSchema: {
                type: 'object',
                properties: { batchId: { type: 'string', description: 'Batch id from create_privacy_deposit_plan.' } },
                required: ['batchId'],
                additionalProperties: false,
            },
        },
        {
            name: 'relay_privacy_refund',
            description:
                'Refund an unclaimed privacy deposit: decrypts the refund payload and depositor secret (requires WALLET_PRIVATE_KEY + PACTPAY_SIGNER_PASSWORD matching the depositor account), generates the refund ZK proof, and submits it. By default tries the platform relayer (POST /api/transaction/:orgId/batches/:batchId/relay-refund) so the platform pays the gas; on chains where platform refund relaying is not supported, set delegate=false to self-relay: the depositor wallet calls the GravArc refund() on-chain (msg.sender == relayer == refunder) and then confirms with the backend. Proof generation can take tens of seconds.',
            inputSchema: {
                type: 'object',
                properties: {
                    batchId: { type: 'string', description: 'Batch id of the deposit to refund.' },
                    delegate: {
                        type: 'boolean',
                        default: true,
                        description:
                            'true (default) = submit via platform relayer (platform pays gas, fee to platform); requires the chain to support refund relaying. false = depositor wallet self-relays the on-chain refund() call (fee returned to depositor); required on chains where platform refund relaying is not supported.',
                    },
                },
                required: ['batchId'],
                additionalProperties: false,
            },
        },
        {
            name: 'confirm_gravarc_refund',
            description:
                'Re-confirm a self-relayed GravArc privacy refund with the backend after the on-chain refund() transaction succeeded (maps to POST /api/transaction/:orgId/batches/:batchId/confirm-refund-gravarc). Use this only if relay_privacy_refund with delegate=false returned a txHash but the backend confirm step failed - the refund is already final on-chain; this just records it.',
            inputSchema: {
                type: 'object',
                properties: {
                    batchId: { type: 'string', description: 'Batch id of the refunded deposit.' },
                    refundTxHash: { type: 'string', description: 'On-chain refund transaction hash from relay_privacy_refund (delegate=false).' },
                },
                required: ['batchId', 'refundTxHash'],
                additionalProperties: false,
            },
        },
        {
            name: 'list_my_payroll_items',
            description:
                'List your own payroll items across all organizations, including privacy deposit withdraw data (tier, encrypted withdraw message, encrypted secret). The service automatically signs a nonce with WALLET_PRIVATE_KEY to obtain the walletToken required by the backend, then calls GET /api/transaction/my-payroll-items. WALLET_PRIVATE_KEY must match the wallet address bound to your account.',
            inputSchema: {
                type: 'object',
                properties: {
                    page: { type: 'number', description: 'Page number, default 1.' },
                    pageSize: { type: 'number', description: 'Page size, default 20.' },
                },
                additionalProperties: false,
            },
        },
        {
            name: 'get_my_payroll_summary',
            description:
                'Summarize your payroll items across organizations: claimed and pending amounts by token, income by organization. Maps to GET /api/transaction/my-summary.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
            name: 'relay_privacy_withdraw',
            description:
                'Withdraw one of your privacy payroll items to a recipient address via the platform relayer (you pay no gas): decrypts your withdraw message and secret with WALLET_PRIVATE_KEY + PACTPAY_SIGNER_PASSWORD, generates the withdraw ZK proof locally, and submits it for relayed execution. Proof generation can take tens of seconds.',
            inputSchema: {
                type: 'object',
                properties: {
                    itemId: { type: 'string', description: 'Payroll item id from list_my_payroll_items.' },
                    recipient: { type: 'string', description: 'EVM address that receives the withdrawn tokens.' },
                },
                required: ['itemId', 'recipient'],
                additionalProperties: false,
            },
        },
        {
            name: 'confirm_withdraw',
            description:
                'Confirm a privacy withdraw you broadcast yourself from your own wallet (not needed after relay_privacy_withdraw). Maps to POST /api/transaction/my-payroll-items/:itemId/confirm-withdraw.',
            inputSchema: {
                type: 'object',
                properties: {
                    itemId: { type: 'string', description: 'Payroll item id.' },
                    txHash: { type: 'string', description: 'On-chain withdraw transaction hash.' },
                },
                required: ['itemId', 'txHash'],
                additionalProperties: false,
            },
        },
    ];

    const handlers: Record<string, (args: any) => Promise<any>> = {
        list_payment_chains: () => service.listChains(),
        create_privacy_deposit_plan: (args) => service.createPrivacyDepositPlan({
            ...(args.caipChainId ? { caipChainId: args.caipChainId } : {}),
            ...(args.tokenAddress ? { tokenAddress: args.tokenAddress } : {}),
            ...(args.transactionName ? { transactionName: args.transactionName } : {}),
            members: args.members,
        }),
        get_privacy_deposit_data: (args) => service.getPrivacyDepositData(args.batchId),
        get_privacy_withdraw_relayer: (args) => service.getRelayerAddress(args.caipChainId),
        execute_privacy_deposit: (args) => service.executePrivacyDeposit(args.batchId),
        relay_privacy_refund: (args) => service.relayPrivacyRefund(args.batchId, { delegate: args.delegate ?? true }),
        confirm_gravarc_refund: (args) => service.confirmGravArcRefundTx(args.batchId, args.refundTxHash),
        list_my_payroll_items: (args) => service.myPayrollItems({ page: args.page, pageSize: args.pageSize }),
        get_my_payroll_summary: () => service.myPayrollSummary(),
        relay_privacy_withdraw: (args) => service.relayPrivacyWithdrawForItem(args.itemId, args.recipient),
        confirm_withdraw: (args) => service.confirmWithdraw(args.itemId, args.txHash),
        get_org_payroll_config: () => service.getOrgPayrollConfig(),
        list_payment_tokens: (args) => service.listPaymentTokens(args.caipChainId),
    };

    return { definitions, handlers };
}
