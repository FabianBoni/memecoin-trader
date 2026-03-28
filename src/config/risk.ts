import { env } from "./env.js";
import type { RiskConfig } from "../types/trade.js";

export const riskConfig: RiskConfig = {
  maxPositionSol: env.DEFAULT_MAX_POSITION_SOL,
  maxOpenExposureSol: env.DEFAULT_MAX_OPEN_EXPOSURE_SOL,
  maxSlippageBps: env.DEFAULT_MAX_SLIPPAGE_BPS,
  stopLossPct: env.DEFAULT_STOP_LOSS_PCT,
  takeProfitPct: env.DEFAULT_TAKE_PROFIT_PCT,
  takeProfitSellFraction: env.DEFAULT_TAKE_PROFIT_SELL_FRACTION,
  minLiveTradeSizeSol: env.MIN_LIVE_TRADE_SIZE_SOL,
  riskPerTradePct: env.RISK_PER_TRADE_PCT,
  maxCapitalAtRiskPct: env.MAX_CAPITAL_AT_RISK_PCT,
  estimatedRoundTripCostBps: env.ESTIMATED_ROUND_TRIP_COST_BPS,
  runnerStopFloorPct: env.RUNNER_STOP_FLOOR_PCT,
  requireExplicitGo: env.REQUIRE_EXPLICIT_GO,
  dryRun: env.DRY_RUN,
};
