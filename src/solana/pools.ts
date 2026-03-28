import type { DexPairSummary } from "../types/market.js";
import type { LiquidityPoolDiscovery } from "../types/token.js";
import { RAYDIUM_AMM_V4_PROGRAM_IDS } from "./raydium.js";

function isSolanaPair(pair: DexPairSummary): boolean {
  return pair.chainId?.toLowerCase() === "solana";
}

function parseMaybePoolAddress(pair: DexPairSummary): string | undefined {
  return pair.pairAddress;
}

function inferProgramHint(pair: DexPairSummary): string | undefined {
  const dexId = pair.dexId?.toLowerCase();
  if (dexId?.includes("raydium")) {
    return [...RAYDIUM_AMM_V4_PROGRAM_IDS][0];
  }
  return undefined;
}

export function discoverCandidatePools(tokenAddress: string, pairs: DexPairSummary[]): LiquidityPoolDiscovery[] {
  return pairs
    .filter(isSolanaPair)
    .filter((pair) => {
      const base = pair.baseToken?.address;
      const quote = pair.quoteToken?.address;
      return base === tokenAddress || quote === tokenAddress;
    })
    .map((pair) => {
      const pool: LiquidityPoolDiscovery = {
        pairAddress: parseMaybePoolAddress(pair) ?? "",
        dexId: pair.dexId ?? "unknown",
        chainId: pair.chainId ?? "solana",
      };

      if (pair.url) pool.url = pair.url;
      if (pair.baseToken?.address) pool.baseTokenAddress = pair.baseToken.address;
      if (pair.quoteToken?.address) pool.quoteTokenAddress = pair.quoteToken.address;

      const programIdHint = inferProgramHint(pair);
      if (programIdHint) pool.programIdHint = programIdHint;

      return pool;
    })
    .filter((pool) => pool.pairAddress.length > 0);
}
