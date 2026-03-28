export interface RiskConfig {
  maxPositionSol: number;
  maxOpenExposureSol: number;
  maxSlippageBps: number;
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitSellFraction: number;
  requireExplicitGo: boolean;
  dryRun: boolean;
}

export type ExecutionMode = "raydium-sdk" | "jupiter";

export interface TradePlan {
  planId: string;
  createdAt: string;
  tokenAddress: string;
  poolAddress?: string;
  dexId?: string;
  executionMode?: ExecutionMode;
  requestedPositionSol: number;
  allowedPositionSol: number;
  currentOpenExposureSol: number;
  projectedOpenExposureSol: number;
  remainingExposureCapacitySol: number;
  finalPositionSol: number;
  maxSlippageBps: number;
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitSellFraction: number;
  dryRun: boolean;
  requiresGo: boolean;
  screenPassed: boolean;
  executable: boolean;
  blockingReasons: string[];
  notes: string[];
}

export interface ApprovalRecord {
  planId: string;
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
  message?: string;
}

export interface OpenPosition {
  tokenAddress: string;
  planId: string;
  sizeSol: number;
  openedAt: string;
  status: "open" | "closed";
}
