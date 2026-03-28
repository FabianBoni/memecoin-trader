import fs from "node:fs";
import path from "node:path";
import { MissingConfigError } from "../config/env.js";
import { TokenScreenService } from "../services/token-screen.js";
import { TradePlanService } from "../services/trade-plan.js";

async function main() {
  const args = process.argv.slice(2);
  const liveMode = args.includes("--live");
  const positionalArgs = args.filter((arg) => arg !== "--live");

  const tokenAddress = positionalArgs[0];
  const requestedPositionSolRaw = positionalArgs[1] ?? "0.3";
  const requestedPositionSol = Number(requestedPositionSolRaw);
  const executionModeRaw = positionalArgs[2] ?? "raydium-sdk";
  const executionMode = executionModeRaw === "jupiter" ? "jupiter" : "raydium-sdk";

  if (!tokenAddress) {
    console.error("Usage: npm run plan:trade -- <TOKEN_MINT_ADDRESS> [REQUESTED_POSITION_SOL] [raydium-sdk|jupiter] [--live]");
    process.exit(1);
  }

  if (Number.isNaN(requestedPositionSol)) {
    console.error(`Invalid position size: ${requestedPositionSolRaw}`);
    process.exit(1);
  }

  const screenService = new TokenScreenService();
  const tradePlanService = new TradePlanService();

  const screen = await screenService.screenToken(tokenAddress);
  const generatedPlan = await tradePlanService.buildTradePlan(tokenAddress, requestedPositionSol, screen, executionMode);
  const plan = {
    ...generatedPlan,
    dryRun: !liveMode,
  };

  const plansDir = path.resolve(process.cwd(), "data/plans");
  fs.mkdirSync(plansDir, { recursive: true });

  const outputPath = path.join(plansDir, `${plan.planId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ screen, plan }, null, 2));

  console.log(JSON.stringify({ screen, plan, outputPath }, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof MissingConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(2);
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Trade plan build failed: ${message}`);
  process.exit(1);
});
