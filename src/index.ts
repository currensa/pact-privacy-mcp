#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { PactPayClient, apiKeyStatusLabel, quotaToUsd } from './client.js';
import { createPaymentTools } from './payment-tools.js';

const serverInfo = {
    name: 'pactpay-mcp-server',
    version: '0.4.0',
};
const baseUrl = process.env.PACTPAY_BASE_URL?.trim() || 'https://pactpay.app';
const authHost = '127.0.0.1';
const authSession = randomUUID();
const callbackPath = '/auth/callback';
const client = new PactPayClient({ baseUrl });
seedCredentialsFromEnv();

function seedCredentialsFromEnv() {
    const envToken = process.env.PACTPAY_TOKEN?.trim() || '';
    const envApiKey = process.env.PACTPAY_API_KEY?.trim() || '';
    const envOrgId = process.env.PACTPAY_ORG_ID?.trim() || '';
    if (envToken) {
        client.setAccessToken(envToken, envOrgId);
        console.error('PactPay MCP: using session token from PACTPAY_TOKEN');
    } else if (envApiKey) {
        client.setApiKey(envApiKey, envOrgId);
        console.error('PactPay MCP: using API key from PACTPAY_API_KEY');
    }
}

const tools: any[] = [
    {
        name: 'open_auth_browser',
        description: 'Open the PactPay auth page in the default browser.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'get_auth_url',
        description: 'Get the front-end auth URL and callback URL for this MCP process.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'set_token',
        description: 'Authenticate this MCP server with a PactPay session token (alternative to browser auth). Uses Authorization: Bearer <token>.',
        inputSchema: {
            type: 'object',
            properties: {
                token: { type: 'string', description: 'PactPay session token.' },
                orgId: { type: 'string', description: 'Optional organization id to pin as current organization.' },
            },
            required: ['token'],
            additionalProperties: false,
        },
    },
    {
        name: 'set_api_key',
        description: 'Authenticate this MCP server itself with a PactPay organization API key (alternative to browser auth). Uses x-api-key header. The key must have mcp scopes. This is an MCP LOGIN credential, NOT a plan key: it is not the kind of key created/managed by create_plan_key / list_api_keys, and it cannot be used to call the LLM gateway.',
        inputSchema: {
            type: 'object',
            properties: {
                apiKey: { type: 'string', description: 'PactPay organization API key used to log in to PactPay (starts with the PactPay key prefix). Not a plan key.' },
                orgId: { type: 'string', description: 'Optional organization id to pin as current organization. Resolved automatically when omitted.' },
            },
            required: ['apiKey'],
            additionalProperties: false,
        },
    },
    {
        name: 'clear_auth',
        description: 'Clear stored credentials (session token or API key) and reset authentication state.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'list_manageable_orgs',
        description: 'List organizations that the current account can manage. Only orgs with admin/operator/owner roles are returned.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'list_org_members',
        description: 'List members of the current organization (maps to GET /api/orgs/:orgId/members). Returns each member\'s memberId (the value to pass to create_privacy_deposit_plan / privacy payroll), showName, email, status, roles, and gravArcAddress (bound GravArc wallet, null if none). Supports keyword search, status/role filters, and sorting. Requires admin (Owner/Admin/Operator) auth.',
        inputSchema: {
            type: 'object',
            properties: {
                page: { type: 'number', default: 1 },
                pageSize: { type: 'number', default: 20 },
                keyword: { type: 'string', description: 'Optional keyword search (matches showName/email).' },
                status: { type: 'string', enum: ['active', 'pending_activation', 'pending_review'] },
                role: { type: 'string', enum: ['Owner', 'Admin', 'Operator', 'Member'] },
                sortBy: { type: 'string', enum: ['showName', 'amount', 'status', 'createdAt', 'lastPayment'] },
                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'get_current_org',
        description: 'Get current MCP organization context and organization detail.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'switch_org',
        description: 'Switch current organization context. Only manageable organizations are allowed.',
        inputSchema: {
            type: 'object',
            properties: {
                orgId: { type: 'string', description: 'Organization id.' },
            },
            required: ['orgId'],
            additionalProperties: false,
        },
    },
    {
        name: 'switch_org_by_name',
        description: 'Switch current organization context by organization name. Uses exact match first, then case-insensitive partial match.',
        inputSchema: {
            type: 'object',
            properties: {
                orgName: { type: 'string', description: 'Organization name.' },
            },
            required: ['orgName'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_plans',
        description: 'List token usage plans under the current organization.',
        inputSchema: {
            type: 'object',
            properties: {
                page: { type: 'number', default: 1 },
                pageSize: { type: 'number', default: 100 },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'list_plans_with_balance',
        description: 'List all plans under the current organization and include computed balance for each plan.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'find_plan_by_name',
        description: 'Find plans in the current organization by plan name. Uses exact match first, then case-insensitive partial match.',
        inputSchema: {
            type: 'object',
            properties: {
                planName: { type: 'string', description: 'Plan name.' },
            },
            required: ['planName'],
            additionalProperties: false,
        },
    },
    {
        name: 'create_plan',
        description: 'Create a new token usage plan under the current organization. Maps to POST /api/orgs/:orgId/token-usage-plans. budget is the spending cap in USD (number string); the actual spendable balance is funded by separate recharges, not by this budget.',
        inputSchema: {
            type: 'object',
            properties: {
                planName: { type: 'string', description: 'Token usage plan name.' },
                budget: { type: 'string', description: 'Budget cap in USD as a number string. Defaults to "0".' },
            },
            required: ['planName'],
            additionalProperties: false,
        },
    },
    {
        name: 'update_plan',
        description: 'Update a token usage plan name and/or budget cap. Maps to PUT /api/orgs/:orgId/token-usage-plans/:id. Only provided fields are changed; at least one of planName or budget must be provided.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                planName: { type: 'string', description: 'New plan name.' },
                budget: { type: 'string', description: 'New budget cap in USD as a number string.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_detail',
        description: 'Get token usage plan detail and profile.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_balance',
        description: 'Get token usage plan budget, remaining quota, used quota, and derived balance numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_profile',
        description: 'Get the forwarded NewAPI user self profile for one plan.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_groups',
        description: 'Get model groups available to one token usage plan.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_models',
        description: 'Get models available to one token usage plan.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_api_keys',
        description: 'Plan key (LLM gateway credential): list the API keys under one token usage plan that plans use to call the LLM gateway. NOT the MCP login credential (that is set via set_api_key). Maps to /api/orgs/:orgId/token-usage-plans/:planId/api-keys.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                page: { type: 'number', default: 1 },
                pageSize: { type: 'number', default: 100 },
                includeSecret: { type: 'boolean', default: false, description: 'Load full key secret for each key.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_plan_keys',
        description: 'Backward-compatible alias of list_api_keys. Lists plan keys (LLM gateway credentials), not the MCP login credential.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                page: { type: 'number', default: 1 },
                pageSize: { type: 'number', default: 100 },
                includeSecret: { type: 'boolean', default: false, description: 'Load full key secret for each key.' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_all_keys_in_current_org',
        description: 'Plan key (LLM gateway credential): list keys across all plans in the current organization. This is the most automatic key listing tool. NOT the MCP login credential.',
        inputSchema: {
            type: 'object',
            properties: {
                includeSecret: { type: 'boolean', default: false, description: 'Load full key secret for each key.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'list_all_keys_across_manageable_orgs',
        description: 'Plan key (LLM gateway credential): list keys across all manageable organizations and all plans. NOT the MCP login credential.',
        inputSchema: {
            type: 'object',
            properties: {
                includeSecret: { type: 'boolean', default: false, description: 'Load full key secret for each key.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'list_all_plans_across_manageable_orgs',
        description: 'List plans across all manageable organizations and include computed balance.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'get_key_test_command',
        description: 'Plan key (LLM gateway credential): get a ready-to-use test command and authorization header for calling the LLM gateway with one plan key.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                apiKeyId: { type: 'string', description: 'Plan key id (the LLM gateway key object id, not the MCP login key).' },
            },
            required: ['planId', 'apiKeyId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_usage_logs',
        description: 'Get usage logs for one token usage plan.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                page: { type: 'number', default: 1 },
                pageSize: { type: 'number', default: 20 },
                type: { type: 'number' },
                tokenName: { type: 'string' },
                modelName: { type: 'string' },
                startTime: { type: 'string' },
                endTime: { type: 'string' },
                channel: { type: 'number' },
                group: { type: 'string' },
                requestId: { type: 'string' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_plan_usage_statistics',
        description: 'Get aggregated usage statistics for one token usage plan.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                type: { type: 'number' },
                tokenName: { type: 'string' },
                modelName: { type: 'string' },
                startTime: { type: 'string' },
                endTime: { type: 'string' },
                channel: { type: 'number' },
                group: { type: 'string' },
                requestId: { type: 'string' },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'create_plan_key',
        description: 'Plan key (LLM gateway credential): create a new API key for one token usage plan, for calling the LLM gateway. NOT the MCP login credential (use set_api_key for that).',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                name: { type: 'string', description: 'API key name.' },
                unlimitedQuota: { type: 'boolean', default: true },
                remainAmount: { type: 'string', description: 'Quota amount in USD string, required when unlimitedQuota=false.' },
                expiredTime: { type: 'number', description: 'UTC+8 timestamp in seconds. Use -1 for never expires.' },
                group: { type: 'string', description: 'API key group. Default is default.' },
                allowIps: { type: 'string', description: 'Optional allow IPs string.' },
                crossGroupRetry: { type: 'boolean', default: false },
                modelLimits: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional allowed model names.',
                },
            },
            required: ['planId', 'name'],
            additionalProperties: false,
        },
    },
    {
        name: 'update_api_key',
        description: 'Plan key (LLM gateway credential): update an API key under a token usage plan. Maps to PUT /api/orgs/:orgId/token-usage-plans/:planId/api-keys/:apiKeyId. Only provided fields are changed; at least one optional field must be provided.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                apiKeyId: { type: 'string', description: 'Plan key id (the LLM gateway key object id, not the MCP login key).' },
                name: { type: 'string', description: 'API key name.' },
                group: { type: 'string', description: 'API key group. Default is default.' },
                unlimitedQuota: { type: 'boolean', description: 'Whether the key has unlimited quota.' },
                remainAmount: { type: 'string', description: 'Quota amount in USD string, required when unlimitedQuota=false.' },
                expiredTime: { type: 'number', description: 'UTC+8 timestamp in seconds. Use -1 for never expires.' },
                allowIps: { type: 'string', description: 'Optional allow IPs string.' },
                crossGroupRetry: { type: 'boolean', description: 'Whether cross-group retry is enabled.' },
                modelLimits: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Allowed model names. Pass an empty array to clear model limits.',
                },
            },
            required: ['planId', 'apiKeyId'],
            additionalProperties: false,
        },
    },
    {
        name: 'delete_api_key',
        description: 'Plan key (LLM gateway credential): delete an API key under a token usage plan. Maps to DELETE /api/orgs/:orgId/token-usage-plans/:planId/api-keys/:apiKeyId.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                apiKeyId: { type: 'string', description: 'Plan key id (the LLM gateway key object id, not the MCP login key).' },
            },
            required: ['planId', 'apiKeyId'],
            additionalProperties: false,
        },
    },
    {
        name: 'set_api_key_status',
        description: 'Plan key (LLM gateway credential): set the status of an API key (enable or disable). Maps to PUT /api/orgs/:orgId/token-usage-plans/:planId/api-keys/:apiKeyId/status. status: 1 = enabled/active, 2 = disabled.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string', description: 'Token usage plan id.' },
                apiKeyId: { type: 'string', description: 'Plan key id (the LLM gateway key object id, not the MCP login key).' },
                status: { type: 'number', description: 'New status. 1 = enabled/active, 2 = disabled.' },
            },
            required: ['planId', 'apiKeyId', 'status'],
            additionalProperties: false,
        },
    },
];

const paymentTools = createPaymentTools(client, {
    signerKey: process.env.WALLET_PRIVATE_KEY?.trim() || undefined,
    signerPassword: process.env.PACTPAY_SIGNER_PASSWORD?.trim() || undefined,
});
tools.push(...paymentTools.definitions);

const toolAliases: Record<string, string> = {
    list_organizations: 'list_manageable_orgs',
    list_orgs: 'list_manageable_orgs',
    list_organization_members: 'list_org_members',
    get_current_organization: 'get_current_org',
    switch_organization: 'switch_org',
    switch_organization_by_name: 'switch_org_by_name',
    list_token_usage_plans: 'list_plans',
    list_usage_plans: 'list_plans',
    list_token_usage_plans_with_balance: 'list_plans_with_balance',
    find_token_usage_plan_by_name: 'find_plan_by_name',
    create_token_usage_plan: 'create_plan',
    create_usage_plan: 'create_plan',
    update_token_usage_plan: 'update_plan',
    get_token_usage_plan_detail: 'get_plan_detail',
    get_token_usage_plan_balance: 'get_plan_balance',
    get_token_usage_plan_profile: 'get_plan_profile',
    get_groups: 'get_plan_groups',
    get_models: 'get_plan_models',
    list_keys: 'list_api_keys',
    get_api_keys: 'list_api_keys',
    list_api_keys_in_plan: 'list_api_keys',
    list_keys_in_plan: 'list_api_keys',
    list_keys_in_current_org: 'list_all_keys_in_current_org',
    list_api_keys_in_current_org: 'list_all_keys_in_current_org',
    list_all_api_keys_in_current_org: 'list_all_keys_in_current_org',
    list_all_api_keys_across_manageable_orgs: 'list_all_keys_across_manageable_orgs',
    list_keys_across_manageable_orgs: 'list_all_keys_across_manageable_orgs',
    list_all_usage_plans_across_manageable_orgs: 'list_all_plans_across_manageable_orgs',
    get_api_key_test_command: 'get_key_test_command',
    get_usage_logs: 'get_plan_usage_logs',
    get_plan_logs: 'get_plan_usage_logs',
    get_usage_statistics: 'get_plan_usage_statistics',
    get_plan_statistics: 'get_plan_usage_statistics',
    create_api_key: 'create_plan_key',
    create_key: 'create_plan_key',
    update_key: 'update_api_key',
    delete_key: 'delete_api_key',
    update_api_key_status: 'set_api_key_status',
    set_key_status: 'set_api_key_status',
};
for (const [alias, canonical] of Object.entries(toolAliases)) {
    const matched = tools.find(tool => tool.name === canonical);
    if (!matched) continue;
    tools.push({
        ...matched,
        name: alias,
        description: `${matched.description} Compatibility alias of ${canonical}.`,
    });
}

let buffer = '';
let framingMode: 'unknown' | 'content-length' | 'newline' = 'unknown';
let authBrowserOpened = false;
let authPort = 0;
let resolveAuthServerReady: (() => void) | null = null;
const authServerReady = new Promise<void>(resolve => {
    resolveAuthServerReady = resolve;
});
startAuthCallbackServer();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    parseIncomingBuffer();
});
process.stdin.on('end', () => process.exit(0));

function send(message: any) {
    const body = JSON.stringify(message);
    if (framingMode === 'newline') {
        process.stdout.write(`${body}\n`);
        return;
    }
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function sendResult(id: any, result: any) {
    send({ jsonrpc: '2.0', id, result });
}

function sendError(id: any, codeValue: number, message: string) {
    send({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: codeValue, message },
    });
}

async function handleMessage(raw: string) {
    let request: any;
    try {
        request = JSON.parse(raw);
    } catch {
        sendError(null, -32700, 'Parse error');
        return;
    }
    if (request.jsonrpc !== '2.0' || !request.method) {
        sendError(request.id, -32600, 'Invalid Request');
        return;
    }
    try {
        if (request.method === 'initialize') {
            sendResult(request.id ?? null, {
                protocolVersion: '2025-06-18',
                capabilities: {
                    tools: {},
                },
                serverInfo,
            });
            return;
        }
        if (request.method === 'notifications/initialized') {
            return;
        }
        if (request.method === 'tools/list') {
            sendResult(request.id ?? null, { tools });
            return;
        }
        if (request.method === 'tools/call') {
            const name = String(request.params?.name ?? '');
            const args = (request.params?.arguments ?? {});
            const result = await callTool(name, args);
            sendResult(request.id ?? null, {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            });
            return;
        }
        sendError(request.id, -32601, `Method not found: ${request.method}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        sendError(request.id, -32603, message);
    }
}

async function callTool(name: string, args: any): Promise<any> {
    const resolvedName = resolveToolName(name);
    const paymentHandler = paymentTools.handlers[resolvedName];
    if (paymentHandler) {
        // Payment tools authenticate lazily; employee-side endpoints require a
        // session token (PACTPAY_TOKEN), admin-side ones accept API keys too.
        if (!client.hasToken()) throw new Error('Authentication credentials are missing - log in first');
        return paymentHandler(args);
    }
    if (resolvedName === 'open_auth_browser') {
        await authServerReady;
        const authUrl = buildAuthUrl();
        await openBrowser(authUrl);
        authBrowserOpened = true;
        return {
            opened: true,
            authUrl,
            callbackUrl: buildCallbackUrl(),
            session: authSession,
        };
    }
    if (resolvedName === 'get_auth_url') {
        await authServerReady;
        return {
            authenticated: client.hasToken(),
            authUrl: buildAuthUrl(),
            callbackUrl: buildCallbackUrl(),
            session: authSession,
            currentOrganization: await getCurrentOrgSummarySafe(),
        };
    }
    if (resolvedName === 'set_token') {
        const token = requireString(args.token, 'token');
        client.setAccessToken(token, optionalString(args.orgId));
        return {
            authenticated: client.hasToken(),
            authType: 'session-token',
            currentOrganization: await getCurrentOrgSummarySafe(),
        };
    }
    if (resolvedName === 'set_api_key') {
        const apiKey = requireString(args.apiKey, 'apiKey');
        client.setApiKey(apiKey, optionalString(args.orgId));
        return {
            authenticated: client.hasToken(),
            authType: 'api-key',
            currentOrganization: await getCurrentOrgSummarySafe(),
        };
    }
    if (resolvedName === 'clear_auth') {
        client.clearAccessToken();
        return { authenticated: false };
    }
    if (resolvedName === 'list_manageable_orgs') {
        await ensureAuthenticated();
        const organizations = await client.getAdminOrganizations(true);
        return {
            currentOrganization: await getCurrentOrgSummarySafe(),
            organizations: organizations.map((item: any) => ({
                orgName: item.organization.orgName,
                orgId: item.organization.orgId,
                roles: (item.member.roles ?? []).map((role: any) => role.role),
                memberCount: item.memberCount ?? null,
                website: item.organization.website ?? null,
                description: item.organization.description ?? item.organization.desc ?? null,
            })),
        };
    }
    if (resolvedName === 'get_current_org') {
        await ensureAuthenticated();
        const detail = await client.getCurrentOrganizationDetail();
        return {
            currentOrganization: {
                orgName: detail.orgName,
                orgId: detail.orgId,
            },
            organization: detail,
        };
    }
    if (resolvedName === 'list_org_members') {
        await ensureAuthenticated();
        const page = requireNumberOrDefault(args.page, 1, 'page');
        const pageSize = requireNumberOrDefault(args.pageSize, 20, 'pageSize');
        const response = await client.listOrgMembers({
            page,
            pageSize,
            keyword: typeof args.keyword === 'string' && args.keyword.trim() ? args.keyword.trim() : undefined,
            status: typeof args.status === 'string' ? args.status : undefined,
            role: typeof args.role === 'string' ? args.role : undefined,
            sortBy: typeof args.sortBy === 'string' ? args.sortBy : undefined,
            sortOrder: typeof args.sortOrder === 'string' ? args.sortOrder : undefined,
        });
        return {
            currentOrganization: await getCurrentOrgSummary(),
            page: response.page,
            pageSize: response.pageSize,
            total: response.total,
            members: (response.data ?? []).map((m: any) => ({
                memberId: m.memberId,
                showName: m.showName,
                email: m.email,
                status: m.status,
                roles: (m.roles ?? []).map((r: any) => r.role),
                createdAt: m.createdAt,
                lastPayment: m.lastPayment,
                gravArcAddress: m.gravArcAddress,
            })),
        };
    }
    if (resolvedName === 'switch_org') {
        await ensureAuthenticated();
        const nextOrgId = requireString(args.orgId, 'orgId');
        const matched = await client.switchOrganization(nextOrgId);
        return {
            currentOrganization: {
                orgName: matched.organization.orgName,
                orgId: matched.organization.orgId,
                roles: (matched.member.roles ?? []).map((role: any) => role.role),
            },
        };
    }
    if (resolvedName === 'switch_org_by_name') {
        await ensureAuthenticated();
        const orgName = requireString(args.orgName, 'orgName');
        const organizations = await client.getAdminOrganizations(true);
        const matched = matchByName(organizations.map((item: any) => ({
            id: item.organization.orgId,
            name: item.organization.orgName,
            item,
        })), orgName, 'organization');
        await client.switchOrganization(matched.id);
        return {
            currentOrganization: {
                orgName: matched.item.organization.orgName,
                orgId: matched.item.organization.orgId,
                roles: (matched.item.member.roles ?? []).map((role: any) => role.role),
            },
        };
    }
    if (resolvedName === 'list_plans') {
        await ensureAuthenticated();
        const page = requireNumberOrDefault(args.page, 1, 'page');
        const pageSize = requireNumberOrDefault(args.pageSize, 100, 'pageSize');
        const response = await client.listPlans(page, pageSize);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            page: response.page,
            pageSize: response.pageSize,
            total: response.total,
            plans: response.data.map((plan: any) => ({
                planName: plan.planName,
                planId: plan.id,
                budget: plan.budget,
                createdAt: plan.createdAt,
                updatedAt: plan.updatedAt,
                deletedAt: plan.deletedAt ?? null,
            })),
        };
    }
    if (resolvedName === 'list_plans_with_balance') {
        await ensureAuthenticated();
        const response = await client.listPlans(1, 100);
        const plans = await Promise.all(response.data.map(async (plan: any) => ({
            planName: plan.planName,
            planId: plan.id,
            budget: plan.budget,
            balance: await client.getPlanBalance(plan.id),
        })));
        return {
            currentOrganization: await getCurrentOrgSummary(),
            total: plans.length,
            plans,
        };
    }
    if (resolvedName === 'find_plan_by_name') {
        await ensureAuthenticated();
        const planName = requireString(args.planName, 'planName');
        const response = await client.listPlans(1, 100);
        const matches = findMatches(response.data.map((item: any) => ({
            id: item.id,
            name: item.planName,
            item,
        })), planName);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            query: planName,
            matches: matches.map((match: any) => ({
                planName: match.item.planName,
                planId: match.item.id,
                budget: match.item.budget,
                createdAt: match.item.createdAt,
                updatedAt: match.item.updatedAt,
            })),
        };
    }
    if (resolvedName === 'create_plan') {
        await ensureAuthenticated();
        const planName = requireString(args.planName, 'planName');
        const budget = args.budget === undefined ? '0' : requireString(String(args.budget), 'budget');
        const created = await client.createPlan({ planName, budget });
        const plan = created?.data ?? created;
        return {
            requestId: randomUUID(),
            currentOrganization: await getCurrentOrgSummary(),
            plan: {
                planName: plan?.planName ?? planName,
                planId: plan?.id ?? '',
                budget: plan?.budget ?? budget,
                createdAt: plan?.createdAt ?? null,
                updatedAt: plan?.updatedAt ?? null,
            },
            result: created,
        };
    }
    if (resolvedName === 'update_plan') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const planName = optionalString(args.planName);
        const budget = args.budget === undefined ? undefined : requireString(String(args.budget), 'budget');
        if (planName === undefined && budget === undefined) {
            throw new Error('Provide at least one of planName or budget to update');
        }
        const updated = await client.updatePlan(planId, { planName, budget });
        const plan = updated?.data ?? updated;
        return {
            requestId: randomUUID(),
            currentOrganization: await getCurrentOrgSummary(),
            plan: {
                planName: plan?.planName ?? planName ?? '',
                planId: plan?.id ?? planId,
                budget: plan?.budget ?? budget ?? null,
                updatedAt: plan?.updatedAt ?? null,
            },
            result: updated,
        };
    }
    if (resolvedName === 'get_plan_detail') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const detail = await client.getPlanDetail(planId);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: {
                planName: detail.plan.planName,
                planId: detail.plan.id,
            },
            detail,
        };
    }
    if (resolvedName === 'get_plan_balance') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const balance = await client.getPlanBalance(planId);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            ...balance,
        };
    }
    if (resolvedName === 'get_plan_profile') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const profile = await client.getPlanProfile(planId);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            profile,
        };
    }
    if (resolvedName === 'get_plan_groups') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const groups = await client.getPlanGroups(planId);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            groups,
        };
    }
    if (resolvedName === 'get_plan_models') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const models = await client.getPlanModels(planId);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            models,
        };
    }
    if (resolvedName === 'list_api_keys' || resolvedName === 'list_plan_keys') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const page = requireNumberOrDefault(args.page, 1, 'page');
        const pageSize = requireNumberOrDefault(args.pageSize, 100, 'pageSize');
        const includeSecret = Boolean(args.includeSecret);
        const response = await client.listApiKeys(planId, page, pageSize);
        const plan = await getPlanSummary(planId);
        const keys = await Promise.all(response.data.map(async (item: any) => ({
            apiKeyName: item.name,
            apiKeyId: String(item.id),
            displayKey: item.key,
            secretKey: includeSecret ? await client.getApiKeySecret(planId, String(item.id)) : undefined,
            status: apiKeyStatusLabel(item.status),
            group: item.group,
            unlimitedQuota: item.unlimited_quota,
            remainUsd: item.unlimited_quota ? null : quotaToUsd(item.remain_quota),
            usedUsd: quotaToUsd(item.used_quota),
            createdTime: item.created_time,
            expiredTime: item.expired_time,
            accessedTime: item.accessed_time,
            modelLimits: item.model_limits ? item.model_limits.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
        })));
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan,
            page: response.page,
            pageSize: response.pageSize,
            total: response.total,
            keys,
        };
    }
    if (resolvedName === 'list_all_keys_in_current_org') {
        await ensureAuthenticated();
        const includeSecret = Boolean(args.includeSecret);
        const response = await client.listPlans(1, 100);
        const plans = await Promise.all(response.data.map(async (plan: any) => {
            const keyResponse = await client.listApiKeys(plan.id, 1, 100);
            const keys = await Promise.all(keyResponse.data.map(async (item: any) => ({
                apiKeyName: item.name,
                apiKeyId: String(item.id),
                displayKey: item.key,
                secretKey: includeSecret ? await client.getApiKeySecret(plan.id, String(item.id)) : undefined,
                status: apiKeyStatusLabel(item.status),
                group: item.group,
                unlimitedQuota: item.unlimited_quota,
                remainUsd: item.unlimited_quota ? null : quotaToUsd(item.remain_quota),
                usedUsd: quotaToUsd(item.used_quota),
                expiredTime: item.expired_time,
                modelLimits: item.model_limits ? item.model_limits.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
            })));
            return {
                planId: plan.id,
                planName: plan.planName,
                keys,
            };
        }));
        return {
            currentOrganization: await getCurrentOrgSummary(),
            planCount: plans.length,
            keyCount: plans.reduce((sum: number, plan: any) => sum + plan.keys.length, 0),
            plans,
        };
    }
    if (resolvedName === 'list_all_plans_across_manageable_orgs') {
        await ensureAuthenticated();
        const currentOrgId = client.getCurrentOrgId();
        const organizations = await client.getAdminOrganizations(true);
        const results: any[] = [];
        for (const org of organizations) {
            await client.switchOrganization(org.organization.orgId);
            const plansResponse = await client.listPlans(1, 100);
            const plans = await Promise.all(plansResponse.data.map(async (plan: any) => ({
                planName: plan.planName,
                planId: plan.id,
                budget: plan.budget,
                balance: await client.getPlanBalance(plan.id),
            })));
            results.push({
                orgId: org.organization.orgId,
                orgName: org.organization.orgName,
                plans,
            });
        }
        if (currentOrgId) {
            try {
                await client.switchOrganization(currentOrgId);
            } catch { /* ignore */ }
        }
        return {
            orgCount: results.length,
            results,
        };
    }
    if (resolvedName === 'list_all_keys_across_manageable_orgs') {
        await ensureAuthenticated();
        const includeSecret = Boolean(args.includeSecret);
        const currentOrgId = client.getCurrentOrgId();
        const organizations = await client.getAdminOrganizations(true);
        const results: any[] = [];
        for (const org of organizations) {
            await client.switchOrganization(org.organization.orgId);
            const plansResponse = await client.listPlans(1, 100);
            const plans = await Promise.all(plansResponse.data.map(async (plan: any) => {
                const keyResponse = await client.listApiKeys(plan.id, 1, 100);
                const keys = await Promise.all(keyResponse.data.map(async (item: any) => ({
                    apiKeyName: item.name,
                    apiKeyId: String(item.id),
                    displayKey: item.key,
                    secretKey: includeSecret ? await client.getApiKeySecret(plan.id, String(item.id)) : undefined,
                    status: apiKeyStatusLabel(item.status),
                    group: item.group,
                    unlimitedQuota: item.unlimited_quota,
                    remainUsd: item.unlimited_quota ? null : quotaToUsd(item.remain_quota),
                    usedUsd: quotaToUsd(item.used_quota),
                    expiredTime: item.expired_time,
                    modelLimits: item.model_limits ? item.model_limits.split(',').map((v: string) => v.trim()).filter(Boolean) : [],
                })));
                return {
                    planId: plan.id,
                    planName: plan.planName,
                    keys,
                };
            }));
            results.push({
                orgId: org.organization.orgId,
                orgName: org.organization.orgName,
                plans,
            });
        }
        if (currentOrgId) {
            try {
                await client.switchOrganization(currentOrgId);
            } catch { /* ignore */ }
        }
        return {
            orgCount: results.length,
            keyCount: results.reduce((sum: number, org: any) => sum + org.plans.reduce((planSum: number, plan: any) => planSum + plan.keys.length, 0), 0),
            results,
        };
    }
    if (resolvedName === 'get_key_test_command') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const apiKeyId = requireString(args.apiKeyId, 'apiKeyId');
        const response = await client.getApiKeyTestCommand(planId, apiKeyId);
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            apiKeyId,
            response,
        };
    }
    if (resolvedName === 'get_plan_usage_logs') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const response = await client.getUsageLogs(planId, {
            page: optionalNumber(args.page, 'page'),
            pageSize: optionalNumber(args.pageSize, 'pageSize'),
            type: optionalNumber(args.type, 'type'),
            tokenName: optionalString(args.tokenName),
            modelName: optionalString(args.modelName),
            startTime: optionalString(args.startTime),
            endTime: optionalString(args.endTime),
            channel: optionalNumber(args.channel, 'channel'),
            group: optionalString(args.group),
            requestId: optionalString(args.requestId),
        });
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            logs: response,
        };
    }
    if (resolvedName === 'get_plan_usage_statistics') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const response = await client.getUsageLogStatistics(planId, {
            type: optionalNumber(args.type, 'type'),
            tokenName: optionalString(args.tokenName),
            modelName: optionalString(args.modelName),
            startTime: optionalString(args.startTime),
            endTime: optionalString(args.endTime),
            channel: optionalNumber(args.channel, 'channel'),
            group: optionalString(args.group),
            requestId: optionalString(args.requestId),
        });
        return {
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            statistics: response,
        };
    }
    if (resolvedName === 'create_plan_key') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const keyName = requireString(args.name, 'name');
        const unlimitedQuota = args.unlimitedQuota === undefined ? true : Boolean(args.unlimitedQuota);
        const remainAmount = args.remainAmount === undefined ? undefined : requireString(args.remainAmount, 'remainAmount');
        const expiredTime = args.expiredTime === undefined ? -1 : requireNumber(args.expiredTime, 'expiredTime');
        const group = args.group === undefined ? undefined : requireString(args.group, 'group');
        const allowIps = optionalString(args.allowIps);
        const crossGroupRetry = args.crossGroupRetry === undefined ? undefined : Boolean(args.crossGroupRetry);
        const modelLimits = Array.isArray(args.modelLimits)
            ? args.modelLimits.map((value: any, index: number) => requireString(value, `modelLimits[${index}]`))
            : undefined;
        if (!unlimitedQuota && !remainAmount) {
            throw new Error('remainAmount is required when unlimitedQuota is false');
        }
        const created = await client.createApiKey(planId, {
            name: keyName,
            unlimitedQuota,
            remainAmount,
            expiredTime,
            group,
            allowIps,
            crossGroupRetry,
            modelLimits,
        });
        const createdRecord: any = created;
        const data = (createdRecord.data ?? createdRecord);
        const apiKeyId = String(data.id ?? '');
        const secretKey = apiKeyId ? await client.getApiKeySecret(planId, apiKeyId) : undefined;
        return {
            requestId: randomUUID(),
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            result: created,
            secretKey,
        };
    }
    if (resolvedName === 'update_api_key') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const apiKeyId = requireString(args.apiKeyId, 'apiKeyId');
        const name = optionalString(args.name);
        const group = args.group === undefined ? undefined : requireString(args.group, 'group');
        const unlimitedQuota = args.unlimitedQuota === undefined ? undefined : Boolean(args.unlimitedQuota);
        const remainAmount = args.remainAmount === undefined ? undefined : requireString(args.remainAmount, 'remainAmount');
        const expiredTime = args.expiredTime === undefined ? undefined : requireNumber(args.expiredTime, 'expiredTime');
        const allowIps = optionalString(args.allowIps);
        const crossGroupRetry = args.crossGroupRetry === undefined ? undefined : Boolean(args.crossGroupRetry);
        const modelLimits = Array.isArray(args.modelLimits)
            ? args.modelLimits.map((value: any, index: number) => requireString(value, `modelLimits[${index}]`))
            : undefined;
        if (unlimitedQuota === false && remainAmount === undefined) {
            throw new Error('remainAmount is required when unlimitedQuota is false');
        }
        if (
            name === undefined &&
            group === undefined &&
            unlimitedQuota === undefined &&
            remainAmount === undefined &&
            expiredTime === undefined &&
            allowIps === undefined &&
            crossGroupRetry === undefined &&
            modelLimits === undefined
        ) {
            throw new Error('Provide at least one field to update');
        }
        const updated = await client.updateApiKey(planId, apiKeyId, {
            name,
            group,
            unlimitedQuota,
            remainAmount,
            expiredTime,
            allowIps,
            crossGroupRetry,
            modelLimits,
        });
        return {
            requestId: randomUUID(),
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            apiKeyId,
            result: updated,
        };
    }
    if (resolvedName === 'delete_api_key') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const apiKeyId = requireString(args.apiKeyId, 'apiKeyId');
        const result = await client.deleteApiKey(planId, apiKeyId);
        return {
            requestId: randomUUID(),
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            apiKeyId,
            deleted: true,
            result,
        };
    }
    if (resolvedName === 'set_api_key_status') {
        await ensureAuthenticated();
        const planId = requireString(args.planId, 'planId');
        const apiKeyId = requireString(args.apiKeyId, 'apiKeyId');
        const status = requireNumber(args.status, 'status');
        const result = await client.updateApiKeyStatus(planId, apiKeyId, status);
        return {
            requestId: randomUUID(),
            currentOrganization: await getCurrentOrgSummary(),
            plan: await getPlanSummary(planId),
            apiKeyId,
            status,
            statusLabel: apiKeyStatusLabel(status),
            result,
        };
    }
    throw new Error(`Unknown tool: ${name}`);
}

async function ensureAuthenticated() {
    try {
        await client.ensureReady();
        await client.ensureCurrentOrgIsAdmin();
        authBrowserOpened = false;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Authentication failed';
        if (client.hasToken()) {
            throw new Error(message);
        }
        await authServerReady;
        const authUrl = buildAuthUrl();
        if (!authBrowserOpened) {
            try {
                await openBrowser(authUrl);
                authBrowserOpened = true;
            } catch (openError) {
                const openMessage = openError instanceof Error ? openError.message : 'Failed to open browser';
                throw new Error(`${message}. Automatic browser open failed: ${openMessage}. Open this URL manually: ${authUrl}`);
            }
        }
        throw new Error(`Authentication required. The browser auth page has been opened. Complete login, then retry. If needed, open this URL manually: ${authUrl}`);
    }
}

function requireString(value: any, field: string): string {
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new Error(`${field} must be a non-empty string`);
}

function optionalString(value: any): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return undefined;
}

function requireNumber(value: any, field: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new Error(`${field} must be a finite number`);
}

function requireNumberOrDefault(value: any, fallback: number, field: string): number {
    if (value === undefined || value === null) return fallback;
    return requireNumber(value, field);
}

function optionalNumber(value: any, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return requireNumber(value, field);
}

async function getCurrentOrgSummary() {
    const detail = await client.getCurrentOrganizationDetail();
    return {
        orgName: detail.orgName,
        orgId: detail.orgId,
    };
}

async function getCurrentOrgSummarySafe() {
    try {
        if (!client.getCurrentOrgId()) return null;
        return await getCurrentOrgSummary();
    } catch {
        return null;
    }
}

async function getPlanSummary(planId: string) {
    const detail = await client.getPlanDetail(planId);
    return {
        planName: detail.plan.planName,
        planId: detail.plan.id,
    };
}

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function findMatches(items: any[], query: string): any[] {
    const normalizedQuery = normalizeName(query);
    const exact = items.filter(item => normalizeName(item.name) === normalizedQuery);
    if (exact.length > 0) return exact;
    return items.filter(item => normalizeName(item.name).includes(normalizedQuery));
}

function matchByName(items: any[], query: string, label: string) {
    const matches = findMatches(items, query);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
        throw new Error(`No ${label} matched "${query}"`);
    }
    throw new Error(`Multiple ${label}s matched "${query}": ${matches.map((item: any) => item.name).join(', ')}`);
}

function resolveToolName(name: string): string {
    return toolAliases[name] ?? name;
}

function parseIncomingBuffer() {
    while (true) {
        if (framingMode === 'unknown') {
            const trimmed = buffer.trimStart();
            if (!trimmed) return;
            if (/^content-length\s*:/i.test(trimmed)) {
                framingMode = 'content-length';
            } else if (trimmed.startsWith('{')) {
                framingMode = 'newline';
            } else {
                return;
            }
        }
        if (framingMode === 'content-length') {
            const parsed = tryReadContentLengthMessage(buffer);
            if (!parsed) return;
            buffer = parsed.rest;
            void handleMessage(parsed.body);
            continue;
        }
        const parsed = tryReadNewlineMessage(buffer);
        if (!parsed) return;
        buffer = parsed.rest;
        if (!parsed.body.trim()) continue;
        void handleMessage(parsed.body);
    }
}

function tryReadContentLengthMessage(value: string): { body: string; rest: string } | null {
    const headerEnd = findHeaderEnd(value);
    if (headerEnd === -1) return null;
    const separatorLength = value.slice(headerEnd, headerEnd + 4) === '\r\n\r\n' ? 4 : 2;
    const header = value.slice(0, headerEnd);
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
        throw new Error('Missing Content-Length header');
    }
    const contentLength = Number(lengthMatch[1]);
    const messageStart = headerEnd + separatorLength;
    const messageEnd = messageStart + contentLength;
    if (value.length < messageEnd) return null;
    return {
        body: value.slice(messageStart, messageEnd),
        rest: value.slice(messageEnd),
    };
}

function tryReadNewlineMessage(value: string): { body: string; rest: string } | null {
    const newlineIndex = value.indexOf('\n');
    if (newlineIndex === -1) return null;
    const rawLine = value.slice(0, newlineIndex);
    const body = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    return {
        body,
        rest: value.slice(newlineIndex + 1),
    };
}

function findHeaderEnd(value: string): number {
    const crlfIndex = value.indexOf('\r\n\r\n');
    if (crlfIndex !== -1) return crlfIndex;
    return value.indexOf('\n\n');
}

function buildCallbackUrl(): string {
    if (!authPort) {
        throw new Error('Auth callback server is not ready');
    }
    return `http://${authHost}:${authPort}${callbackPath}?session=${encodeURIComponent(authSession)}`;
}

function buildAuthUrl(): string {
    return `${baseUrl.replace(/\/+$/, '')}/mcp-auth?callback=${encodeURIComponent(buildCallbackUrl())}`;
}

async function openBrowser(url: string) {
    if (process.platform === 'win32') {
        await spawnDetached('cmd', ['/c', 'start', '', url]);
        return;
    }
    if (process.platform === 'darwin') {
        await spawnDetached('open', [url]);
        return;
    }
    await spawnDetached('xdg-open', [url]);
}

function startAuthCallbackServer() {
    const server = createServer((request, response) => {
        const requestUrl = new URL(request.url || '/', `http://${authHost}:${authPort}`);
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (request.method === 'OPTIONS') {
            response.writeHead(204);
            response.end();
            return;
        }
        if (requestUrl.pathname !== callbackPath) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        if (requestUrl.searchParams.get('session') !== authSession) {
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Invalid session');
            return;
        }
        if (request.method === 'GET') {
            const tokenValue = requestUrl.searchParams.get('token')?.trim() || '';
            const orgIdValue = requestUrl.searchParams.get('orgId')?.trim() || '';
            if (!tokenValue) {
                response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Missing token');
                return;
            }
            client.setAccessToken(tokenValue, orgIdValue);
            authBrowserOpened = false;
            writeAuthSuccessPage(response);
            return;
        }
        if (request.method === 'POST') {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            request.on('end', () => {
                try {
                    const rawBody = Buffer.concat(chunks).toString('utf8');
                    const contentType = String(request.headers['content-type'] || '');
                    const body = contentType.includes('application/json')
                        ? parseJsonBody(rawBody)
                        : parseFormBody(rawBody);
                    const tokenValue = String(body.token || '').trim();
                    const orgIdValue = String(body.orgId || '').trim();
                    if (!tokenValue) {
                        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                        response.end('Missing token');
                        return;
                    }
                    client.setAccessToken(tokenValue, orgIdValue);
                    authBrowserOpened = false;
                    writeAuthSuccessPage(response);
                } catch (error) {
                    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                    response.end(error instanceof Error ? error.message : 'Invalid request body');
                }
            });
            return;
        }
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method not allowed');
    });
    server.listen(0, authHost, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Failed to resolve auth callback port');
        }
        authPort = address.port;
        resolveAuthServerReady?.();
        resolveAuthServerReady = null;
        console.error(`PactPay MCP auth callback listening on ${buildCallbackUrl()}`);
        console.error(`PactPay MCP auth page: ${buildAuthUrl()}`);
    });
}

function parseJsonBody(rawBody: string): any {
    return JSON.parse(rawBody);
}

function parseFormBody(rawBody: string): Record<string, string> {
    const params = new URLSearchParams(rawBody);
    return Object.fromEntries(params.entries());
}

function spawnDetached(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

function writeAuthSuccessPage(response: any) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>PactPay MCP Auth</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 32px; color: #1c1c26; }
      .card { max-width: 560px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 16px; padding: 24px; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      p { line-height: 1.6; color: #606067; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Authentication complete</h1>
      <p>The token has been received by the local MCP server.</p>
      <p>You can return to your MCP client and close this page.</p>
    </div>
    <script>
      setTimeout(() => { try { window.close() } catch (_) {} }, 300);
    </script>
  </body>
</html>`);
}
