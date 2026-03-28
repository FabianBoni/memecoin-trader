import { env } from "./env.js";
import type { RiskConfig } from "../types/trade.js";

export const riskConfig: RiskConfig = {
  maxPositionSol: env.DEFAULT_MAX_POSITION_SOL,
  maxOpenExposureSol: env.DEFAULT_MAX_OPEN_EXPOSURE_SOL,
  maxSlippageBps: env.DEFAULT_MAX_SLIPPAGE_BPS,
  stopLossPct: env.DEFAULT_STOP_LOSS_PCT,
  takeProfitPct: env.DEFAULT_TAKE_PROFIT_PCT,
  takeProfitSellFraction: env.DEFAULT_TAKE_PROFIT_SELL_FRACTION,
  requireExplicitGo: env.REQUIRE_EXPLICIT_GO,
  dryRun: env.DRY_RUN,
};
