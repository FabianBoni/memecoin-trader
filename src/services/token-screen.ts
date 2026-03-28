import { HeliusClient } from "../clients/helius.js";
import { LiquidityScreenService } from "./liquidity-screen.js";
import { createAsyncLimiter, isSolanaRpcRateLimitError } from "../solana/rpc-guard.js";
import type { TokenSecurityScreen, SplTokenMintAccountInfo } from "../types/token.js";

export interface TokenScreenOptions {
  skipLiquidityChecks?: boolean;
}

const TOKEN_SCREEN_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_SCREEN_STALE_TTL_MS = 30 * 60 * 1000;
const TOKEN_SCREEN_CONCURRENCY = 2;

const tokenScreenCache = new Map<string, { fetchedAt: number; result: TokenSecurityScreen }>();
const inFlightTokenScreens = new Map<string, Promise<TokenSecurityScreen>>();
const limitTokenScreen = createAsyncLimiter(TOKEN_SCREEN_CONCURRENCY);

function getTokenScreenCacheKey(tokenAddress: string, options?: TokenScreenOptions): string {
  return JSON.stringify([tokenAddress, options?.skipLiquidityChecks === true]);
}

function isAuthorityRevoked(option?: number, authority?: string | null): boolean {
  if (option === 0) return true;
  if (authority === null) return true;
  if (authority === undefined) return false;
  return authority.trim().length === 0;
}

function buildAuthorityChecks(info: SplTokenMintAccountInfo) {
  return {
    mintAuthorityRevoked: isAuthorityRevoked(info.mintAuthorityOption, info.mintAuthority),
    freezeAuthorityRevoked: isAuthorityRevoked(info.freezeAuthorityOption, info.freezeAuthority),
  };
}

export class TokenScreenService {
  constructor(
    private readonly heliusClient = new HeliusClient(),
    private readonly liquidityScreenService = new LiquidityScreenService(),
  ) {}

  private cloneScreenResult(result: TokenSecurityScreen): TokenSecurityScreen {
    return {
      ...result,
      warnings: [...result.warnings],
      reasons: [...result.reasons],
      source: { ...result.source },
      ...(result.liquidity
        ? {
            liquidity: {
              ...result.liquidity,
              reasons: [...result.liquidity.reasons],
              warnings: [...result.liquidity.warnings],
              evidence: [...result.liquidity.evidence],
              ...(result.liquidity.pool ? { pool: { ...result.liquidity.pool } } : {}),
              ...(result.liquidity.pumpFun
                ? { pumpFun: { ...result.liquidity.pumpFun, reasons: [...result.liquidity.pumpFun.reasons], evidence: [...result.liquidity.pumpFun.evidence] } }
                : {}),
            },
          }
        : {}),
    };
  }

  private async buildScreenResult(tokenAddress: string, options?: TokenScreenOptions): Promise<TokenSecurityScreen> {
    const warnings: string[] = [];
    const reasons: string[] = [];

    const mintInfo = await this.heliusClient.getParsedTokenMintInfo(tokenAddress);
    const checks = buildAuthorityChecks(mintInfo);
    const liquidity = options?.skipLiquidityChecks ? undefined : await this.liquidityScreenService.screenLiquidity(tokenAddress);

    if (!checks.mintAuthorityRevoked) {
      reasons.push("Mint Authority is still enabled.");
    }

    if (!checks.freezeAuthorityRevoked) {
      reasons.push("Freeze Authority is still enabled.");
    }

    if (liquidity) {
      warnings.push(...liquidity.warnings);
      reasons.push(...liquidity.reasons);
    }

    return {
      tokenAddress,
      mintAuthorityRevoked: checks.mintAuthorityRevoked,
      freezeAuthorityRevoked: checks.freezeAuthorityRevoked,
      liquidityCheckPassed: liquidity?.passed ?? true,
      liquidityCheckStatus: liquidity?.status ?? "not-implemented",
      passed: checks.mintAuthorityRevoked && checks.freezeAuthorityRevoked && (liquidity?.passed ?? true),
      warnings,
      reasons,
      source: {
        heliusRpcUrl: this.heliusClient.getRpcUrl(),
      },
      ...(liquidity ? { liquidity } : {}),
    };
  }

  async screenToken(tokenAddress: string, options?: TokenScreenOptions): Promise<TokenSecurityScreen> {
    const cacheKey = getTokenScreenCacheKey(tokenAddress, options);
    const cached = tokenScreenCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < TOKEN_SCREEN_CACHE_TTL_MS) {
      return this.cloneScreenResult(cached.result);
    }

    const inFlight = inFlightTokenScreens.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const request = limitTokenScreen(async () => {
      try {
        const result = await this.buildScreenResult(tokenAddress, options);
        tokenScreenCache.set(cacheKey, { fetchedAt: Date.now(), result });
        return this.cloneScreenResult(result);
      } catch (error) {
        const stale = tokenScreenCache.get(cacheKey);
        if (stale && isSolanaRpcRateLimitError(error) && Date.now() - stale.fetchedAt < TOKEN_SCREEN_STALE_TTL_MS) {
          const cachedResult = this.cloneScreenResult(stale.result);
          cachedResult.warnings.push("Token screen served from stale cache after RPC rate limit.");
          return cachedResult;
        }

        throw error;
      }
    }).finally(() => {
      inFlightTokenScreens.delete(cacheKey);
    });

    inFlightTokenScreens.set(cacheKey, request);
    return request;
  }
}
