export interface DexPairSummary {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  txns?: {
    m5?: {
      buys?: number;
      sells?: number;
    };
    h1?: {
      buys?: number;
      sells?: number;
    };
    h6?: {
      buys?: number;
      sells?: number;
    };
    h24?: {
      buys?: number;
      sells?: number;
    };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  baseToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
  quoteToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  url?: string;
}
