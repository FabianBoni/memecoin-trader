import type { ApprovalRecord } from "../types/trade.js";
import { getDatabase, isDatabaseEnabled } from "./database.js";
import { loadJsonFile, saveJsonFile } from "./json-store.js";

const APPROVALS_FILE = "approvals.json";

type ApprovalRow = {
  payload_json: string;
};

export async function loadApprovals(): Promise<ApprovalRecord[]> {
  if (!isDatabaseEnabled()) {
    return loadJsonFile<ApprovalRecord[]>(APPROVALS_FILE, []);
  }

  const db = getDatabase();
  const rows = db.prepare(`
    SELECT payload_json
    FROM plan_approvals
    ORDER BY COALESCE(approved_at, '') DESC, plan_id ASC
  `).all() as ApprovalRow[];

  if (rows.length === 0) {
    const legacyApprovals = await loadJsonFile<ApprovalRecord[]>(APPROVALS_FILE, []);
    if (legacyApprovals.length > 0) {
      for (const approval of legacyApprovals) {
        await saveApproval(approval);
      }
    }
    return legacyApprovals;
  }

  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json) as ApprovalRecord];
    } catch (error) {
      console.warn("Konnte Approval-Datensatz nicht parsen:", error);
      return [];
    }
  });
}

export async function saveApproval(record: ApprovalRecord): Promise<void> {
  if (!isDatabaseEnabled()) {
    const approvals = await loadApprovals();
    const existingIndex = approvals.findIndex((item) => item.planId === record.planId);

    if (existingIndex >= 0) {
      approvals[existingIndex] = record;
    } else {
      approvals.push(record);
    }

    await saveJsonFile(APPROVALS_FILE, approvals);
    return;
  }

  const db = getDatabase();
  db.prepare(`
    INSERT INTO plan_approvals (plan_id, approved, approved_at, approved_by, message, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      approved = excluded.approved,
      approved_at = excluded.approved_at,
      approved_by = excluded.approved_by,
      message = excluded.message,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    record.planId,
    record.approved ? 1 : 0,
    record.approvedAt ?? null,
    record.approvedBy ?? null,
    record.message ?? null,
    JSON.stringify(record, null, 2),
    new Date().toISOString(),
  );

  const approvals = await loadApprovals();
  const existingIndex = approvals.findIndex((item) => item.planId === record.planId);

  if (existingIndex >= 0) {
    approvals[existingIndex] = record;
  } else {
    approvals.push(record);
  }

  await saveJsonFile(APPROVALS_FILE, approvals);
}
