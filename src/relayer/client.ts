export type RelayerQuote = {
  id: string;
  operation?: "withdraw" | "refund";
  chainId: number;
  gravArc: string;
  relayer: string;
  token: string;
  amount: string;
  tier: number;
  networkFee: string;
  serviceFee: string;
  fee: string;
  serviceFeeBps: number;
  expiresAt: string;
};

export type WithdrawQuote = RelayerQuote;
export type RefundQuote = RelayerQuote;

export type RelayerOperation = {
  id: string;
  operation?: "withdraw" | "refund";
  chainId: number;
  state: "queued" | "simulating" | "signed" | "submitted" | "confirmed" | "failed";
  transactionHash: string | null;
  blockNumber: number | null;
  error: { code: string; message: string | null } | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  idempotent?: boolean;
};

export class RelayerHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = "RelayerHttpError";
  }
}

export function normalizeRelayerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Relayer URL must use HTTP or HTTPS");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export class RelayerClient {
  readonly baseUrl: string;

  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = normalizeRelayerUrl(baseUrl);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...options, headers });
    const body = await response.json().catch(() => undefined) as {
      message?: string | string[];
      error?: string | { code?: string; message?: string | string[] };
      code?: string;
    } | undefined;
    if (!response.ok) {
      const nested = typeof body?.error === "object" ? body.error : undefined;
      const nestedMessage = Array.isArray(nested?.message) ? nested.message.join(", ") : nested?.message;
      const detail = nestedMessage ?? (Array.isArray(body?.message) ? body.message.join(", ") : body?.message);
      const code = nested?.code ?? body?.code ?? (typeof body?.error === "string" ? body.error : undefined);
      throw new RelayerHttpError(response.status, code, detail ?? `Relayer request failed (${response.status})`);
    }
    return body as T;
  }

  quoteWithdraw(input: { chainId: number; token: string; amount: string; tier: number }): Promise<WithdrawQuote> {
    return this.request<WithdrawQuote>("/v1/withdraw/quote", { method: "POST", body: JSON.stringify(input) });
  }

  quoteRefund(input: { chainId: number; token: string; amount: string; tier: number }): Promise<RefundQuote> {
    return this.request<RefundQuote>("/v1/refund/quote", { method: "POST", body: JSON.stringify(input) });
  }

  submitRefund(input: { chainId: number; quoteId: string; calldata: string }): Promise<RelayerOperation> {
    return this.request<RelayerOperation>("/v1/refund", { method: "POST", body: JSON.stringify(input) });
  }

  submitWithdraw(input: { chainId: number; quoteId: string; calldata: string }): Promise<RelayerOperation> {
    return this.request<RelayerOperation>("/v1/withdraw", { method: "POST", body: JSON.stringify(input) });
  }

  operation(id: string): Promise<RelayerOperation> {
    return this.request<RelayerOperation>(`/v1/operations/${encodeURIComponent(id)}`);
  }
}
