import { env } from "../config/env.js";

const DEFAULT_JITO_BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf";
const DEFAULT_JITO_TIP_LAMPORTS = 1_000;

type JitoEncoding = "base64";

interface JitoJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JitoJsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: JitoJsonRpcError;
}

interface JitoJsonRpcRequest<TParams> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: TParams;
}

export interface JitoBundlePayload extends JitoJsonRpcRequest<[string[], { encoding: JitoEncoding }]> {
  method: "sendBundle";
}

export interface JitoTransactionPayload extends JitoJsonRpcRequest<[string, { encoding: JitoEncoding }]> {
  method: "sendTransaction";
}

interface JitoBundleStatusesResult {
  context?: {
    slot?: number;
  };
  value?: Array<{
    bundle_id: string;
    transactions: string[];
    slot: number;
    confirmation_status?: string;
    confirmationStatus?: string;
    err?: unknown;
  } | null> | null;
}

interface JitoInflightBundleStatusesResult {
  context?: {
    slot?: number;
  };
  value?: Array<{
    bundle_id: string;
    status: "Invalid" | "Pending" | "Failed" | "Landed";
    landed_slot: number | null;
  } | null> | null;
}

interface JitoTipAccountsResult extends Array<string> {}

export interface PreparedJitoBundleSubmission {
  endpoint: string;
  authKeyPresent: boolean;
  tipLamports?: number;
  payload: JitoBundlePayload;
  dryRun: boolean;
}

export interface PreparedJitoTransactionSubmission {
  endpoint: string;
  authKeyPresent: boolean;
  tipLamports?: number;
  payload: JitoTransactionPayload;
  dryRun: boolean;
  bundleOnly: boolean;
}

export interface JitoSubmittedBundle extends PreparedJitoBundleSubmission {
  bundleId: string;
}

export interface JitoSubmittedTransaction extends PreparedJitoTransactionSubmission {
  signature: string;
  bundleId?: string;
}

export interface JitoBundleStatus {
  bundleId: string;
  transactions: string[];
  slot: number;
  confirmationStatus?: string;
  err?: unknown;
}

export interface JitoInflightBundleStatus {
  bundleId: string;
  status: "Invalid" | "Pending" | "Failed" | "Landed";
  landedSlot: number | null;
}

export function resolveJitoTipLamports(): number | undefined {
  if (env.JITO_BUNDLE_TIP_LAMPORTS === undefined) {
    return DEFAULT_JITO_TIP_LAMPORTS;
  }

  if (env.JITO_BUNDLE_TIP_LAMPORTS <= 0) {
    return undefined;
  }

  return Math.max(env.JITO_BUNDLE_TIP_LAMPORTS, DEFAULT_JITO_TIP_LAMPORTS);
}

export class JitoClient {
  private static tipAccountsCache: string[] | null = null;

  private resolveBaseUrl(): string {
    const configured = env.JITO_BLOCK_ENGINE_URL?.trim();
    return configured && configured.length > 0
      ? configured.replace(/\/+$/, "")
      : DEFAULT_JITO_BLOCK_ENGINE_URL;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(path, `${this.resolveBaseUrl()}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    return url;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };

    const authKey = env.JITO_AUTH_KEY?.trim();
    if (authKey) {
      headers["x-jito-auth"] = authKey;
    }

    return headers;
  }

  private async postJsonRpc<TResult, TParams>(params: {
    url: URL;
    payload: JitoJsonRpcRequest<TParams>;
    errorContext: string;
  }): Promise<{ result: TResult; headers: Headers }> {
    const response = await fetch(params.url.toString(), {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(params.payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${params.errorContext} failed with status ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = await response.json() as JitoJsonRpcResponse<TResult>;
    if (json.error) {
      throw new Error(`${params.errorContext} RPC error ${json.error.code}: ${json.error.message}`);
    }

    if (json.result === undefined) {
      throw new Error(`${params.errorContext} returned no result.`);
    }

    return {
      result: json.result,
      headers: response.headers,
    };
  }

  prepareBundle(serializedTransactionsBase64: string[]): PreparedJitoBundleSubmission {
    const tipLamports = resolveJitoTipLamports();
    return {
      endpoint: this.buildUrl("/api/v1/bundles").toString(),
      authKeyPresent: Boolean(env.JITO_AUTH_KEY),
      dryRun: env.DRY_RUN,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTransactionsBase64, { encoding: "base64" }],
      },
      ...(tipLamports !== undefined ? { tipLamports } : {}),
    };
  }

  prepareTransaction(serializedTransactionBase64: string, options?: { bundleOnly?: boolean }): PreparedJitoTransactionSubmission {
    const bundleOnly = options?.bundleOnly !== false;
    const tipLamports = resolveJitoTipLamports();
    return {
      endpoint: this.buildUrl("/api/v1/transactions", bundleOnly ? { bundleOnly: "true" } : undefined).toString(),
      authKeyPresent: Boolean(env.JITO_AUTH_KEY),
      dryRun: env.DRY_RUN,
      bundleOnly,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [serializedTransactionBase64, { encoding: "base64" }],
      },
      ...(tipLamports !== undefined ? { tipLamports } : {}),
    };
  }

  async submitBundle(serializedTransactionsBase64: string[]): Promise<JitoSubmittedBundle> {
    const prepared = this.prepareBundle(serializedTransactionsBase64);
    const { result } = await this.postJsonRpc<string, JitoBundlePayload["params"]>({
      url: new URL(prepared.endpoint),
      payload: prepared.payload,
      errorContext: "Jito sendBundle",
    });

    return {
      ...prepared,
      bundleId: result,
    };
  }

  async submitTransaction(
    serializedTransactionBase64: string,
    options?: { bundleOnly?: boolean },
  ): Promise<JitoSubmittedTransaction> {
    const prepared = this.prepareTransaction(serializedTransactionBase64, options);
    const { result, headers } = await this.postJsonRpc<string, JitoTransactionPayload["params"]>({
      url: new URL(prepared.endpoint),
      payload: prepared.payload,
      errorContext: "Jito sendTransaction",
    });

    const bundleId = headers.get("x-bundle-id") ?? undefined;
    return {
      ...prepared,
      signature: result,
      ...(bundleId ? { bundleId } : {}),
    };
  }

  async getBundleStatuses(bundleIds: string[]): Promise<JitoBundleStatus[]> {
    if (bundleIds.length === 0) {
      return [];
    }

    const { result } = await this.postJsonRpc<JitoBundleStatusesResult, [string[]]>({
      url: this.buildUrl("/api/v1/getBundleStatuses"),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [bundleIds],
      },
      errorContext: "Jito getBundleStatuses",
    });

    return (result.value ?? [])
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => ({
        bundleId: entry.bundle_id,
        transactions: entry.transactions,
        slot: entry.slot,
        ...((entry.confirmation_status ?? entry.confirmationStatus) !== undefined
          ? { confirmationStatus: entry.confirmation_status ?? entry.confirmationStatus }
          : {}),
        ...(entry.err !== undefined ? { err: entry.err } : {}),
      }));
  }

  async getInflightBundleStatuses(bundleIds: string[]): Promise<JitoInflightBundleStatus[]> {
    if (bundleIds.length === 0) {
      return [];
    }

    const { result } = await this.postJsonRpc<JitoInflightBundleStatusesResult, [string[]]>({
      url: this.buildUrl("/api/v1/getInflightBundleStatuses"),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "getInflightBundleStatuses",
        params: [bundleIds],
      },
      errorContext: "Jito getInflightBundleStatuses",
    });

    return (result.value ?? [])
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => ({
        bundleId: entry.bundle_id,
        status: entry.status,
        landedSlot: entry.landed_slot,
      }));
  }

  async getFirstInflightBundleStatus(bundleId: string): Promise<JitoInflightBundleStatus | null> {
    const statuses = await this.getInflightBundleStatuses([bundleId]);
    return statuses[0] ?? null;
  }

  async getTipAccounts(options?: { forceRefresh?: boolean }): Promise<string[]> {
    if (!options?.forceRefresh && JitoClient.tipAccountsCache && JitoClient.tipAccountsCache.length > 0) {
      return JitoClient.tipAccountsCache;
    }

    const { result } = await this.postJsonRpc<JitoTipAccountsResult, []>({
      url: this.buildUrl("/api/v1/getTipAccounts"),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "getTipAccounts",
        params: [],
      },
      errorContext: "Jito getTipAccounts",
    });

    JitoClient.tipAccountsCache = [...result];
    return JitoClient.tipAccountsCache;
  }

}
