import { loadTradePlans } from "../storage/trades.js";
import { ExecutionGateService } from "../services/execution-gate.js";

async function main() {
  const planId = process.argv[2];
  const approvedBy = process.argv[3] ?? "Fabian";
  const message = process.argv[4];

  if (!planId) {
    console.error("Usage: npm run approve:plan -- <PLAN_ID> [APPROVED_BY] [MESSAGE]");
    process.exit(1);
  }

  const plans = await loadTradePlans();
  const plan = plans.find((item) => item.planId === planId);
  if (!plan) {
    console.error(`Plan not found: ${planId}`);
    process.exit(1);
  }

  const gate = new ExecutionGateService();
  const approval = await gate.approvePlan(plan, approvedBy, message);
  console.log(JSON.stringify({ planId, approval }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Plan approval failed: ${message}`);
  process.exit(1);
});
