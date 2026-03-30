import { riskConfig } from "../config/risk.js";
import { saveTradePlan } from "../storage/trades.js";
import type { TokenSecurityScreen } from "../types/token.js";
import type { ExecutionMode, TradePlan } from "../types/trade.js";
import { nowIso } from "../utils/time.js";
import { getExposureSummary } from "./exposure.js";
import { suggestExecutionModeForPool } from "./execution-routing.js";

function makePlanId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const nonce = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PLAN-${stamp}-${nonce}`;
}

function roundSol(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export class TradePlanService {
  async buildTradePlan(
    tokenAddress: string,
    requestedPositionSol: number,
    screen: TokenSecurityScreen,
    executionMode?: ExecutionMode,
  ): Promise<TradePlan> {
    const exposure = await getExposureSummary(riskConfig.maxOpenExposureSol);
    const blockingReasons: string[] = [];
    const notes: string[] = [];

    const allowedPositionSol = Math.min(riskConfig.maxPositionSol, exposure.remainingExposureCapacitySol);
    const finalPositionSol = Math.min(requestedPositionSol, allowedPositionSol);
    const projectedOpenExposureSol = roundSol(exposure.currentOpenExposureSol + finalPositionSol);

    if (!screen.passed) {
      blockingReasons.push(...screen.reasons);
    }

    if (requestedPositionSol > riskConfig.maxPositionSol) {
      blockingReasons.push(`Requested position ${requestedPositionSol} SOL exceeds max per-trade size of ${riskConfig.maxPositionSol} SOL.`);
    }

    if (requestedPositionSol <= 0) {
      blockingReasons.push("Requested position must be greater than 0 SOL.");
    }

    if (exposure.currentOpenExposureSol >= riskConfig.maxOpenExposureSol) {
      blockingReasons.push(`Current open exposure ${exposure.currentOpenExposureSol} SOL already meets or exceeds the max exposure of ${riskConfig.maxOpenExposureSol} SOL.`);
    }

    if (projectedOpenExposureSol > riskConfig.maxOpenExposureSol) {
      blockingReasons.push(`Projected exposure ${projectedOpenExposureSol} SOL exceeds max open exposure of ${riskConfig.maxOpenExposureSol} SOL.`);
    }

    if (finalPositionSol <= 0) {
      blockingReasons.push("No remaining exposure capacity is available for a new position.");
    }

    if (finalPositionSol < requestedPositionSol && finalPositionSol > 0) {
      notes.push(`Position clipped from ${requestedPositionSol} SOL to ${finalPositionSol} SOL by risk limits.`);
    }

    const resolvedExecutionMode = executionMode ?? suggestExecutionModeForPool(screen.liquidity?.pool ?? null);

    const plan: TradePlan = {
      planId: makePlanId(),
      createdAt: nowIso(),
      tokenAddress,
      executionMode: resolvedExecutionMode,
      requestedPositionSol: roundSol(requestedPositionSol),
      allowedPositionSol: roundSol(allowedPositionSol),
      currentOpenExposureSol: roundSol(exposure.currentOpenExposureSol),
      projectedOpenExposureSol,
      remainingExposureCapacitySol: roundSol(exposure.remainingExposureCapacitySol),
      finalPositionSol: roundSol(finalPositionSol),
      maxSlippageBps: riskConfig.maxSlippageBps,
      stopLossPct: riskConfig.stopLossPct,
      takeProfitPct: riskConfig.takeProfitPct,
      takeProfitSellFraction: riskConfig.takeProfitSellFraction,
      dryRun: riskConfig.dryRun,
      requiresGo: riskConfig.requireExplicitGo,
      screenPassed: screen.passed,
      executable: blockingReasons.length === 0,
      blockingReasons,
      notes,
    };

    const verifiedPoolAddress = screen.liquidity?.pool?.pairAddress;
    const verifiedDexId = screen.liquidity?.pool?.dexId;

    if (verifiedPoolAddress) {
      plan.poolAddress = verifiedPoolAddress;
    }

    if (verifiedDexId) {
      plan.dexId = verifiedDexId;
    }

    if (resolvedExecutionMode === "raydium-sdk" && verifiedDexId && !verifiedDexId.toLowerCase().includes("raydium")) {
      plan.notes.push(`Execution mode raydium-sdk was requested, but the verified pool dex is ${verifiedDexId}.`);
    }

    if (resolvedExecutionMode === "pumpfun-amm" && verifiedDexId && verifiedDexId.toLowerCase() !== "pumpfun-amm" && verifiedDexId.toLowerCase() !== "pumpswap") {
      plan.notes.push(`Execution mode pumpfun-amm was requested, but the verified pool dex is ${verifiedDexId}.`);
    }

    if (!verifiedPoolAddress) {
      plan.blockingReasons.push("No verified pool address was captured in the approved screen result.");
      plan.executable = false;
    }

    await saveTradePlan(plan);
    return plan;
  }
}
