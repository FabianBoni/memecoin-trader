import { loadApprovals, saveApproval } from "../storage/approvals.js";
import type { ApprovalRecord, TradePlan } from "../types/trade.js";
import { nowIso } from "../utils/time.js";

export class ExecutionGateService {
  async getApproval(planId: string): Promise<ApprovalRecord | undefined> {
    const approvals = await loadApprovals();
    return approvals.find((approval) => approval.planId === planId);
  }

  async approvePlan(plan: TradePlan, approvedBy: string, message?: string): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      planId: plan.planId,
      approved: true,
      approvedAt: nowIso(),
      approvedBy,
    };

    if (message) {
      record.message = message;
    }

    await saveApproval(record);
    return record;
  }

  async assertExecutable(plan: TradePlan): Promise<void> {
    if (!plan.executable) {
      throw new Error(`Plan ${plan.planId} is not executable: ${plan.blockingReasons.join('; ')}`);
    }

    if (!plan.requiresGo) {
      return;
    }

    const approval = await this.getApproval(plan.planId);
    if (!approval?.approved) {
      throw new Error(`Plan ${plan.planId} is missing explicit approval. Expected: GO ${plan.planId}`);
    }
  }
}
