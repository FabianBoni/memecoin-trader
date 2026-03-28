import type { ApprovalRecord } from "../types/trade.js";
import { loadJsonFile, saveJsonFile } from "./json-store.js";

const APPROVALS_FILE = "approvals.json";

export async function loadApprovals(): Promise<ApprovalRecord[]> {
  return loadJsonFile<ApprovalRecord[]>(APPROVALS_FILE, []);
}

export async function saveApproval(record: ApprovalRecord): Promise<void> {
  const approvals = await loadApprovals();
  const existingIndex = approvals.findIndex((item) => item.planId === record.planId);

  if (existingIndex >= 0) {
    approvals[existingIndex] = record;
  } else {
    approvals.push(record);
  }

  await saveJsonFile(APPROVALS_FILE, approvals);
}
