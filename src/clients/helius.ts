import { execSync } from "node:child_process";
import { env, getHeliusRpcUrl, getReadOnlyRpcUrl } from "../config/env.js";
import { createAsyncLimiter, isSolanaRpcRateLimitError, withRpcRetry } from "../solana/rpc-guard.js";
import type { RawAccountInfo, SplTokenMintAccountInfo, TokenAccountInfo } from "../types/token.js";

interface RpcResponse<T> {
  jsonrpc: string;
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface ParsedAccountData<TInfo> {
  program: string;
  parsed?: {
    info?: TInfo;
    type?: string;
  };
}

interface AccountInfoValue<TInfo> {
  data?: ParsedAccountData<TInfo> | [string, string];
  executable?: boolean;
  lamports?: number;
  owner?: string;
  rentEpoch?: number;
  space?: number;
}

interface GetAccountInfoResult<TInfo> {
  context: {
    slot: number;
  };
  value: AccountInfoValue<TInfo> | null;
}

interface TokenAccountsByOwnerResult {
  context: {
    slot: number;
  };
  value: Array<{
    pubkey: string;
    account: AccountInfoValue<TokenAccountInfo>;
  }>;
}

interface HeliusPriorityFeeResponse {
  jsonrpc: string;
  id: string | number;
  result?: {
    priorityFeeEstimate?: number;
  };
  error?: {
    code: number;
    message: string;
  };
}

const HELIUS_RPC_CONCURRENCY = 2;
const HELIUS_RPC_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
const ACCOUNT_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_ACCOUNTS_CACHE_TTL_MS = 60 * 1000;
const PRIORITY_FEE_CACHE_TTL_MS = 15 * 1000;

const limitHeliusRpc = createAsyncLimiter(HELIUS_RPC_CONCURRENCY);
const inFlightRpcRequests = new Map<string, Promise<unknown>>();
const rpcResponseCache = new Map<string, { expiresAt: number; value: unknown }>();

function redactRpcUrl(url: string): string {
  return url.replace(/([?&]api-key=)[^&]+/gi, "$1<redacted>");
}

function getRpcCacheKey(rpcUrl: string, method: string, params: unknown[]): string {
  return JSON.stringify([rpcUrl, method, params]);
}

function readRpcCache<T>(cacheKey: string): T | undefined {
  const cached = rpcResponseCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (Date.now() > cached.expiresAt) {
    rpcResponseCache.delete(cacheKey);
    return undefined;
  }

  return cached.value as T;
}

function writeRpcCache(cacheKey: string, value: unknown, ttlMs: number) {
  if (ttlMs <= 0) {
    return;
  }

  rpcResponseCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

function getDefaultCacheTtlMs(method: string): number {
  switch (method) {
    case "getAccountInfo":
      return ACCOUNT_INFO_CACHE_TTL_MS;
    case "getTokenAccountsByOwner":
      return TOKEN_ACCOUNTS_CACHE_TTL_MS;
    case "getPriorityFeeEstimate":
      return PRIORITY_FEE_CACHE_TTL_MS;
    default:
      return 0;
  }
}

function makeRpcHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": "curl/7.68.0",
  };

  if (env.HELIUS_API_KEY && env.HELIUS_API_KEY.trim().length > 0) {
    headers["x-api-key"] = env.HELIUS_API_KEY;
  }

  return headers;
}

function execCurlJson(rpcUrl: string, body: object): string {
  const payload = JSON.stringify(body).replace(/'/g, `'"'"'`);
  const headerArgs = Object.entries(makeRpcHeaders())
    .map(([key, value]) => `-H '${key}: ${value.replace(/'/g, `'"'"'`)}'`)
    .join(" ");
  const command = `curl -s -X POST '${rpcUrl.replace(/'/g, `'"'"'`)}' ${headerArgs} --data '${payload}'`;
  return execSync(command, { encoding: "utf8" });
}

export class HeliusClient {
  private readonly rpcUrl: string;

  constructor(rpcUrl = getHeliusRpcUrl()) {
    this.rpcUrl = rpcUrl;
  }

  getRpcUrl(): string {
    return this.rpcUrl;
  }

  private async doRpcRequest<T>(body: object, method: string, rpcUrl: string): Promise<T> {
    let rawText: string;

    if (env.RPC_DEBUG_USE_CURL) {
      rawText = execCurlJson(rpcUrl, body);
    } else {
      console.log("Fetching:", redactRpcUrl(rpcUrl));

      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: makeRpcHeaders(),
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const bodyText = await response.text();
          console.error("Helius RPC non-OK response:", {
            url: redactRpcUrl(rpcUrl),
            method,
            status: response.status,
            statusText: response.statusText,
            body: bodyText,
          });
          throw new Error(`Helius RPC request failed with status ${response.status}`);
        }

        rawText = await response.text();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Helius RPC fetch failed:", {
          url: redactRpcUrl(rpcUrl),
          method,
          message,
          error,
        });
        throw error;
      }
    }

    const payload = JSON.parse(rawText) as RpcResponse<T>;

    if (payload.error) {
      throw new Error(`Helius RPC error ${payload.error.code}: ${payload.error.message}`);
    }

    if (payload.result === undefined) {
      throw new Error(`Helius RPC returned no result for method ${method}`);
    }

    return payload.result;
  }

  private async rpcRequest<T>(
    id: string,
    method: string,
    params: unknown[],
    rpcUrl = this.rpcUrl,
    cacheTtlMs = getDefaultCacheTtlMs(method),
  ): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    };
    const cacheKey = getRpcCacheKey(rpcUrl, method, params);
    const cached = readRpcCache<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const inFlight = inFlightRpcRequests.get(cacheKey);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const requestPromise = limitHeliusRpc(async () => withRpcRetry(
      async () => {
        try {
          const result = await this.doRpcRequest<T>(body, method, rpcUrl);
          writeRpcCache(cacheKey, result, cacheTtlMs);
          return result;
        } catch (error) {
          const fallbackRpcUrl = getReadOnlyRpcUrl(this.rpcUrl, { preferDistinct: true });
          if (
            rpcUrl === this.rpcUrl
            && fallbackRpcUrl !== rpcUrl
            && isSolanaRpcRateLimitError(error)
          ) {
            console.warn(`Helius RPC rate limited for ${method}. Retrying via fallback RPC.`);
            return this.doRpcRequest<T>(body, method, fallbackRpcUrl);
          }

          throw error;
        }
      },
      {
        delaysMs: HELIUS_RPC_RETRY_DELAYS_MS,
        onRetry: (delayMs, attempt) => {
          console.warn(`Helius RPC rate limited for ${method}. Retry ${attempt}/${HELIUS_RPC_RETRY_DELAYS_MS.length} in ${delayMs}ms.`);
        },
      },
    )).finally(() => {
      inFlightRpcRequests.delete(cacheKey);
    });

    inFlightRpcRequests.set(cacheKey, requestPromise);
    return requestPromise as Promise<T>;
  }

  async getParsedTokenMintInfo(tokenAddress: string): Promise<SplTokenMintAccountInfo> {
    let result = await this.rpcRequest<GetAccountInfoResult<SplTokenMintAccountInfo>>(
      `mint-${tokenAddress}`,
      "getAccountInfo",
      [tokenAddress, { encoding: "jsonParsed" }],
    );

    const fallbackRpcUrl = getReadOnlyRpcUrl(this.rpcUrl, { preferDistinct: true });

    if (result.value === null && fallbackRpcUrl !== this.rpcUrl) {
      result = await this.rpcRequest<GetAccountInfoResult<SplTokenMintAccountInfo>>(
        `mint-fallback-${tokenAddress}`,
        "getAccountInfo",
        [tokenAddress, { encoding: "jsonParsed" }],
        fallbackRpcUrl,
      );
    }

    const account = result.value;
    const parsed = account?.data as ParsedAccountData<SplTokenMintAccountInfo> | undefined;
    const info = parsed?.parsed?.info;

    if (!info) {
      if (result.value === null) {
        throw new Error(
          "RPC returned null - check if your API key supports Mainnet or if the cluster is correct.",
        );
      }

      throw new Error("Token mint account info not found or not parseable.");
    }

    return info;
  }

  async getParsedTokenAccountInfo(address: string): Promise<TokenAccountInfo> {
    const result = await this.rpcRequest<GetAccountInfoResult<TokenAccountInfo>>(
      `token-account-${address}`,
      "getAccountInfo",
      [address, { encoding: "jsonParsed", commitment: "confirmed" }],
    );

    const account = result.value;
    const parsed = account?.data as ParsedAccountData<TokenAccountInfo> | undefined;
    const info = parsed?.parsed?.info;

    if (!info) {
      throw new Error("Token account info not found or not parseable.");
    }

    return info;
  }

  async getRawAccountInfo(address: string): Promise<RawAccountInfo> {
    const result = await this.rpcRequest<GetAccountInfoResult<never>>(
      `raw-${address}`,
      "getAccountInfo",
      [address, { encoding: "base64", commitment: "confirmed" }],
    );

    const account = result.value;
    if (!account || !Array.isArray(account.data) || account.data[1] !== "base64") {
      throw new Error("Raw account info not found or not returned as base64.");
    }

    const rawAccount: RawAccountInfo = {
      dataBase64: account.data[0],
      executable: account.executable ?? false,
      lamports: account.lamports ?? 0,
      owner: account.owner ?? "",
    };

    if (account.rentEpoch !== undefined) rawAccount.rentEpoch = account.rentEpoch;
    if (account.space !== undefined) rawAccount.space = account.space;

    return rawAccount;
  }

  async getTokenAccountsByOwner(ownerAddress: string, mintAddress: string) {
    const result = await this.rpcRequest<TokenAccountsByOwnerResult>(
      `token-accounts-${ownerAddress}-${mintAddress}`,
      "getTokenAccountsByOwner",
      [
        ownerAddress,
        { mint: mintAddress },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    );

    return result.value.map((entry) => {
      const parsed = entry.account.data as ParsedAccountData<TokenAccountInfo> | undefined;
      return {
        pubkey: entry.pubkey,
        info: parsed?.parsed?.info,
      };
    });
  }

  async getPriorityFeeEstimate(accountKeys: string[] = []): Promise<number | undefined> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getPriorityFeeEstimate",
      params: [{ accountKeys, options: { recommended: true } }],
    };
    const cacheKey = getRpcCacheKey(this.rpcUrl, "getPriorityFeeEstimate", body.params);
    const cached = readRpcCache<number | undefined>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = await limitHeliusRpc(async () => withRpcRetry(async () => {
      console.log("Fetching:", redactRpcUrl(this.rpcUrl));

      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: makeRpcHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        console.error("Helius priority fee non-OK response:", {
          url: redactRpcUrl(this.rpcUrl),
          status: response.status,
          statusText: response.statusText,
          body: bodyText,
        });
        throw new Error(`Helius priority fee request failed with status ${response.status}`);
      }

      const payload = await response.json() as HeliusPriorityFeeResponse;
      if (payload.error) {
        console.error("Helius priority fee RPC error:", {
          url: redactRpcUrl(this.rpcUrl),
          code: payload.error.code,
          message: payload.error.message,
        });
        throw new Error(`Helius priority fee error ${payload.error.code}: ${payload.error.message}`);
      }

      return payload.result?.priorityFeeEstimate;
    }, {
      delaysMs: HELIUS_RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`Helius priority fee rate limited. Retry ${attempt}/${HELIUS_RPC_RETRY_DELAYS_MS.length} in ${delayMs}ms.`);
      },
    }));

    writeRpcCache(cacheKey, result, PRIORITY_FEE_CACHE_TTL_MS);
    return result;
  }
}
