export interface TokenAuthorities {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
}

export interface LiquidityPoolDiscovery {
  pairAddress: string;
  dexId: string;
  chainId: string;
  url?: string;
  baseTokenAddress?: string;
  quoteTokenAddress?: string;
  lpMintAddress?: string;
  programIdHint?: string;
}

export interface PumpFunCheckResult {
  detected: boolean;
  bondingCurveAddress?: string;
  canonicalPoolAddress?: string;
  canonicalPoolDetected?: boolean;
  status: "not-pump" | "bonding-curve-live" | "migrated" | "unknown";
  complete?: boolean;
  reasons: string[];
  evidence: string[];
}

export interface LiquidityCheckResult {
  passed: boolean;
  status: "passed" | "failed" | "unknown" | "not-found";
  pool?: LiquidityPoolDiscovery;
  lpMintAddress?: string;
  lpSupplyRaw?: string;
  burnedLpRaw?: string;
  lockedLpRaw?: string;
  unlockedLpRaw?: string;
  burnedPct?: number;
  lockedPct?: number;
  lockerAddress?: string;
  lockerLabel?: string;
  pumpFun?: PumpFunCheckResult;
  reasons: string[];
  warnings: string[];
  evidence: string[];
}

export interface TokenSecurityScreen {
  tokenAddress: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  liquidityCheckPassed: boolean;
  liquidityCheckStatus: "not-implemented" | "passed" | "failed" | "unknown" | "not-found";
  passed: boolean;
  warnings: string[];
  reasons: string[];
  source: {
    heliusRpcUrl: string;
  };
  liquidity?: LiquidityCheckResult;
}

export interface SplTokenMintAccountInfo {
  mintAuthorityOption?: number;
  mintAuthority?: string | null;
  supply?: string;
  decimals?: number;
  isInitialized?: boolean;
  freezeAuthorityOption?: number;
  freezeAuthority?: string | null;
}

export interface TokenAccountInfo {
  mint?: string;
  owner?: string;
  tokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmount?: number | null;
    uiAmountString?: string;
  };
}

export interface RawAccountInfo {
  dataBase64: string;
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch?: number;
  space?: number;
}
