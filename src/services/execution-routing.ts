import type { LiquidityPoolDiscovery } from "../types/token.js";
import type { ExecutionMode } from "../types/trade.js";

const HOT_EXECUTION_MAX_LIQUIDITY_USD = 150_000;
const HOT_EXECUTION_MIN_WHALE_BUY_SIZE_SOL = 1;

export function normalizeDexId(dexId?: string | null): string | undefined {
  const normalized = dexId?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function isRaydiumDex(dexId?: string | null): boolean {
  return normalizeDexId(dexId)?.includes("raydium") ?? false;
}

export function isPumpAmmDex(dexId?: string | null): boolean {
  const normalized = normalizeDexId(dexId);
  return normalized === "pumpfun-amm" || normalized === "pumpswap";
}

export function suggestExecutionModeForPool(
  pool?: Pick<LiquidityPoolDiscovery, "dexId"> | null,
): ExecutionMode {
  if (isPumpAmmDex(pool?.dexId)) {
    return "pumpfun-amm";
  }

  if (isRaydiumDex(pool?.dexId)) {
    return "raydium-sdk";
  }

  return "jupiter";
}

export function chooseHotExecutionMode(params: {
  mint: string;
  dexId?: string | null;
  liquidityUsd?: number | null;
  whaleBuySizeSol?: number | null;
}): ExecutionMode {
  const directMode = suggestExecutionModeForPool(params.dexId ? { dexId: params.dexId } : null);
  if (directMode === "jupiter") {
    return directMode;
  }

  const hotByMint = params.mint.toLowerCase().endsWith("pump");
  const hotByLiquidity = typeof params.liquidityUsd === "number"
    && Number.isFinite(params.liquidityUsd)
    && params.liquidityUsd > 0
    && params.liquidityUsd <= HOT_EXECUTION_MAX_LIQUIDITY_USD;
  const hotByWhaleSize = typeof params.whaleBuySizeSol === "number"
    && Number.isFinite(params.whaleBuySizeSol)
    && params.whaleBuySizeSol >= HOT_EXECUTION_MIN_WHALE_BUY_SIZE_SOL;

  return hotByMint || hotByLiquidity || hotByWhaleSize
    ? directMode
    : "jupiter";
}