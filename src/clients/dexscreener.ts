import { env } from "../config/env.js";
import type { DexPairSummary } from "../types/market.js";

interface DexscreenerResponse {
  schemaVersion?: string;
  pairs?: DexPairSummary[];
}

export class DexscreenerClient {
  private readonly baseUrl: string;

  constructor(baseUrl = env.DEXSCREENER_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async searchTokenPairs(tokenAddress: string): Promise<DexPairSummary[]> {
    const url = `${this.baseUrl}/dex/tokens/${encodeURIComponent(tokenAddress)}`;
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Dexscreener request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as DexscreenerResponse;
    return payload.pairs ?? [];
  }
}
