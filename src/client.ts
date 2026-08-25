const NEWAPI_QUOTA_RATIO = 500000;

function trimSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function firstString(...values: any[]): string {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return '';
}

function firstNumber(...values: any[]): number {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return 0;
}

function normalizeList(payload: unknown): any[] {
    if (Array.isArray(payload)) return payload;
    const record = asRecord(payload);
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.list)) return record.list;
    const dataRecord = asRecord(record.data);
    if (Array.isArray(dataRecord.data)) return dataRecord.data;
    if (Array.isArray(dataRecord.items)) return dataRecord.items;
    if (Array.isArray(dataRecord.list)) return dataRecord.list;
    return [];
}

function hasAdminRole(roles: any[]): boolean {
    return (roles ?? []).some((role: any) => role.role !== 'Member');
}

export function quotaToUsd(value: unknown): string {
    const quota = firstNumber(value);
    if (quota <= 0) return '0';
    return (quota / NEWAPI_QUOTA_RATIO).toFixed(6).replace(/\.?0+$/, '');
}

export function apiKeyStatusLabel(status: unknown): string {
    if (status === 4) return 'Exhausted';
    if (status === 3) return 'Expired';
    if (status === 2) return 'Disabled';
    return 'Active';
}

export interface PactPayClientOptions {
    baseUrl: string;
}

export interface CreatePlanInput {
    planName: string;
    budget: string | number;
}

export interface CreateApiKeyInput {
    name: string;
    group?: string;
    expiredTime?: number;
    unlimitedQuota?: boolean;
    remainAmount?: string;
    modelLimits?: string[];
    crossGroupRetry?: boolean;
    allowIps?: string;
}

export interface UpdatePlanInput {
    planName?: string;
    budget?: string | number;
}

export interface UpdateApiKeyInput {
    name?: string;
    group?: string;
    expiredTime?: number;
    unlimitedQuota?: boolean;
    remainAmount?: string;
    modelLimits?: string[];
    crossGroupRetry?: boolean;
    allowIps?: string;
}

export interface RequestOptions {
    method?: string;
    body?: any;
    skipAuth?: boolean;
}

export class PactPayClient {
    baseUrl: string;
    token?: string;
    apiKey?: string;
    orgId?: string;
    organizationsCache: any[] | null = null;

    constructor(options: PactPayClientOptions) {
        this.baseUrl = trimSlash(options.baseUrl);
    }

    hasToken(): boolean {
        return Boolean(this.token || this.apiKey);
    }

    setAccessToken(token: string, orgId?: string) {
        this.token = token.trim();
        this.apiKey = undefined;
        this.organizationsCache = null;
        this.orgId = orgId?.trim() || undefined;
    }

    setApiKey(apiKey: string, orgId?: string) {
        this.apiKey = apiKey.trim();
        this.token = undefined;
        this.organizationsCache = null;
        this.orgId = orgId?.trim() || undefined;
    }

    clearAccessToken() {
        this.token = undefined;
        this.apiKey = undefined;
        this.orgId = undefined;
        this.organizationsCache = null;
    }

    getCurrentOrgId(): string | undefined {
        return this.orgId;
    }

    setCurrentOrgId(orgId: string) {
        this.orgId = orgId.trim();
    }

    async ensureReady() {
        if (!this.token && !this.apiKey) {
            throw new Error('Authentication credentials are missing');
        }
        if (!this.orgId) {
            this.orgId = await this.resolveDefaultOrgId();
        }
    }

    async getOrganizations(forceRefresh = false): Promise<any[]> {
        if (!this.token && !this.apiKey) {
            throw new Error('Authentication credentials are missing');
        }
        if (!forceRefresh && this.organizationsCache) {
            return this.organizationsCache;
        }
        const orgs = await this.request('/api/orgs');
        this.organizationsCache = orgs;
        return orgs;
    }

    async getAdminOrganizations(forceRefresh = false): Promise<any[]> {
        const organizations = await this.getOrganizations(forceRefresh);
        return organizations.filter((item: any) => hasAdminRole(item.member.roles));
    }

    async ensureCurrentOrgIsAdmin() {
        await this.ensureReady();
        const currentOrgId = this.requireOrgId();
        const adminOrgs = await this.getAdminOrganizations();
        const matched = adminOrgs.find((item: any) => item.organization.orgId === currentOrgId);
        if (!matched) {
            if (adminOrgs.length > 0) {
                this.orgId = adminOrgs[0].organization.orgId;
                return adminOrgs[0];
            }
            throw new Error(`Current organization ${currentOrgId} is not manageable by this account`);
        }
        return matched;
    }

    async switchOrganization(orgId: string) {
        const adminOrgs = await this.getAdminOrganizations();
        const matched = adminOrgs.find((item: any) => item.organization.orgId === orgId);
        if (!matched) {
            throw new Error(`Organization ${orgId} is not manageable by this account`);
        }
        this.orgId = orgId;
        return matched;
    }

    async getCurrentOrganizationDetail() {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}`);
    }

    async listPlans(page = 1, pageSize = 100) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans?page=${page}&pageSize=${pageSize}`);
    }

    async listOrgMembers(query: {
        page?: number;
        pageSize?: number;
        keyword?: string;
        status?: string;
        role?: string;
        sortBy?: string;
        sortOrder?: string;
    } = {}) {
        await this.ensureCurrentOrgIsAdmin();
        const params = new URLSearchParams();
        params.set('page', String(query.page ?? 1));
        params.set('pageSize', String(query.pageSize ?? 20));
        if (query.keyword) params.set('keyword', query.keyword);
        if (query.status) params.set('status', query.status);
        if (query.role) params.set('role', query.role);
        if (query.sortBy) params.set('sortBy', query.sortBy);
        if (query.sortOrder) params.set('sortOrder', query.sortOrder);
        return this.request(`/api/orgs/${this.requireOrgId()}/members?${params.toString()}`);
    }

    async getOrgPayrollConfig(): Promise<{ caipChainId: string; token: string } | null> {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/payroll-config`);
    }

    async listPaymentTokens(caipChainId?: string): Promise<any[]> {
        const suffix = caipChainId ? `?caipChainId=${encodeURIComponent(caipChainId)}` : '';
        const raw = await this.request(`/api/chain-asset${suffix}`, { skipAuth: true });
        const rows = Array.isArray(raw) ? raw : (raw?.data ?? []);
        return (rows ?? []).map((item: any) => ({
            caipChainId: String(item.caipChainId ?? ''),
            symbol: String(item.asset?.symbol ?? ''),
            name: String(item.asset?.name ?? ''),
            contractAddress: item.contractAddress ?? null,
            decimals: item.decimals ?? null,
            isNative: Boolean(item.isNative),
            isStable: Boolean(item.asset?.isStable),
            chainName: String(item.chain?.name ?? ''),
        }));
    }

    async createPlan(input: CreatePlanInput) {
        await this.ensureCurrentOrgIsAdmin();
        const body = {
            planName: input.planName.trim(),
            budget: String(input.budget ?? '0'),
        };
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans`, {
            method: 'POST',
            body,
        });
    }

    async getPlanDetail(planId: string) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}`);
    }

    async updatePlan(planId: string, input: UpdatePlanInput) {
        await this.ensureCurrentOrgIsAdmin();
        const body: Record<string, any> = {};
        if (input.planName !== undefined) body.planName = input.planName.trim();
        if (input.budget !== undefined) body.budget = String(input.budget);
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}`, {
            method: 'PUT',
            body,
        });
    }

    async getPlanProfile(planId: string) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/profile`);
    }

    async getPlanGroups(planId: string) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/groups`);
    }

    async getPlanModels(planId: string) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/models`);
    }

    async getPlanBalance(planId: string) {
        const detail = await this.getPlanDetail(planId);
        const remainingQuota = Math.max(0, firstNumber(detail.profile?.quota));
        const usedQuota = Math.max(0, firstNumber(detail.profile?.used_quota));
        const totalPurchased = remainingQuota + usedQuota;
        return {
            planId: detail.plan.id,
            planName: detail.plan.planName,
            username: firstString(detail.profile?.username, detail.profile?.display_name),
            email: firstString(detail.profile?.email),
            budgetUsd: detail.plan.budget,
            remainingUsd: quotaToUsd(remainingQuota),
            usedUsd: quotaToUsd(usedQuota),
            totalPurchasedUsd: quotaToUsd(totalPurchased),
            status: detail.profile?.status === 2 || detail.plan.deletedAt ? 'Disabled' : 'Active',
            raw: detail,
        };
    }

    async listApiKeys(planId: string, page = 1, pageSize = 100) {
        await this.ensureCurrentOrgIsAdmin();
        const raw = await this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys?page=${page}&pageSize=${pageSize}`);
        const payload = asRecord(raw);
        const dataPayload = asRecord(payload.data);
        return {
            data: normalizeList(raw),
            page: firstNumber(payload.page, dataPayload.page, page),
            pageSize: firstNumber(payload.pageSize, payload.page_size, dataPayload.pageSize, dataPayload.page_size, pageSize),
            total: firstNumber(payload.total, dataPayload.total, 0),
        };
    }

    async createApiKey(planId: string, input: CreateApiKeyInput) {
        await this.ensureCurrentOrgIsAdmin();
        const body = {
            name: input.name.trim(),
            group: input.group?.trim() || 'default',
            expiredTime: input.expiredTime ?? -1,
            unlimitedQuota: input.unlimitedQuota ?? true,
            remainAmount: input.unlimitedQuota === false ? input.remainAmount : undefined,
            modelLimitsEnabled: Boolean(input.modelLimits?.length),
            modelLimits: input.modelLimits?.join(',') ?? '',
            crossGroupRetry: input.crossGroupRetry ?? false,
            allowIps: input.allowIps,
        };
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys`, {
            method: 'POST',
            body,
        });
    }

    async getApiKeySecret(planId: string, apiKeyId: string) {
        await this.ensureCurrentOrgIsAdmin();
        const raw = await this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys/${apiKeyId}/key`, { method: 'POST' });
        const root = asRecord(raw);
        const data = asRecord(root.data);
        return firstString(data.key, root.key);
    }

    async updateApiKey(planId: string, apiKeyId: string, input: UpdateApiKeyInput) {
        await this.ensureCurrentOrgIsAdmin();
        const body: Record<string, any> = {};
        if (input.name !== undefined) body.name = input.name.trim();
        if (input.group !== undefined) body.group = input.group.trim() || 'default';
        if (input.unlimitedQuota !== undefined) body.unlimitedQuota = input.unlimitedQuota;
        if (input.remainAmount !== undefined) body.remainAmount = input.remainAmount;
        if (input.expiredTime !== undefined) body.expiredTime = input.expiredTime;
        if (input.allowIps !== undefined) body.allowIps = input.allowIps;
        if (input.crossGroupRetry !== undefined) body.crossGroupRetry = input.crossGroupRetry;
        if (input.modelLimits !== undefined) {
            body.modelLimitsEnabled = input.modelLimits.length > 0;
            body.modelLimits = input.modelLimits.join(',');
        }
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys/${apiKeyId}`, {
            method: 'PUT',
            body,
        });
    }

    async deleteApiKey(planId: string, apiKeyId: string) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys/${apiKeyId}`, {
            method: 'DELETE',
        });
    }

    async updateApiKeyStatus(planId: string, apiKeyId: string, status: number) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys/${apiKeyId}/status`, {
            method: 'PUT',
            body: { status },
        });
    }

    async getApiKeyTestCommand(planId: string, apiKeyId: string) {
        await this.ensureCurrentOrgIsAdmin();
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/api-keys/${apiKeyId}/test-command`);
    }

    async getUsageLogs(planId: string, query: Record<string, any> = {}) {
        await this.ensureCurrentOrgIsAdmin();
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === '') continue;
            params.set(key, String(value));
        }
        const suffix = params.size ? `?${params.toString()}` : '';
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/logs${suffix}`);
    }

    async getUsageLogStatistics(planId: string, query: Record<string, any> = {}) {
        await this.ensureCurrentOrgIsAdmin();
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null || value === '') continue;
            params.set(key, String(value));
        }
        const suffix = params.size ? `?${params.toString()}` : '';
        return this.request(`/api/orgs/${this.requireOrgId()}/token-usage-plans/${planId}/logs/statistics${suffix}`);
    }

    requireOrgId(): string {
        if (!this.orgId) {
            throw new Error('Organization not resolved');
        }
        return this.orgId;
    }

    async resolveDefaultOrgId(): Promise<string> {
        const orgs = await this.request('/api/orgs');
        this.organizationsCache = orgs;
        if (!orgs.length) {
            throw new Error('No organizations available for current account');
        }
        const adminOrg = orgs.find((item: any) => hasAdminRole(item.member.roles));
        return (adminOrg ?? orgs[0]).organization.orgId;
    }

    async request(path: string, options: RequestOptions = {}) {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (!options.skipAuth) {
            if (this.apiKey) {
                headers['x-api-key'] = this.apiKey;
            } else if (this.token) {
                headers.Authorization = `Bearer ${this.token}`;
            } else {
                throw new Error('Authentication credentials are missing');
            }
        }
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: options.method ?? 'GET',
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (!response.ok) {
            const message = firstString(asRecord(data).message, response.statusText, 'Request failed');
            throw new Error(`${response.status} ${message}`);
        }
        return data;
    }
}
