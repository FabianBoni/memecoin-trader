import { readJsonFileSync, writeJsonFileSync } from "./json-file-sync.js";
import { resolveSrcDataPath } from "../utils/repo-paths.js";

const DECISION_LOG_PATH = resolveSrcDataPath("decision-log.json");
const MAX_DECISION_LOG_ENTRIES = 400;

export type DecisionLogCategory = "cluster" | "entry" | "paper" | "live";

export type DecisionLogOutcome =
  | "cluster-floor-blocked"
  | "paper-bypass"
  | "paper-signal-blocked"
  | "entry-rejected"
  | "paper-opened"
  | "paper-entry-missing"
  | "live-skipped-active-position"
  | "live-blocked"
  | "live-sizing-blocked"
  | "live-opened"
  | "live-buy-failed";

export type DecisionLogEntry = {
  id: string;
  detectedAt: string;
  category: DecisionLogCategory;
  outcome: DecisionLogOutcome;
  whale: string;
  mint: string;
  mode: "paper" | "live";
  detail: string;
  reasons: string[];
  notes: string[];
  signature: string | null;
  performanceTier: string | null;
  sampleSize: number | null;
  signalClass: string | null;
  signalStrategy: string | null;
  clusterWalletCount: number | null;
  clusterPremiumWalletCount: number | null;
  clusterInsiderWalletCount: number | null;
  whaleBuySizeSol: number | null;
  whaleBuySizeUsd: number | null;
  liquidityUsd: number | null;
  entryPrice: number | null;
  entryPriceSource: string | null;
  priceExtensionPct: number | null;
  expectedNetProfitPct: number | null;
  rewardRiskRatio: number | null;
  dexId: string | null;
  poolAddress: string | null;
  preferredExecutionMode: string | null;
  buyAttemptCount: number | null;
  errorMessage: string | null;
};

type DecisionLogEntryInput = Omit<DecisionLogEntry, "id" | "detectedAt"> & {
  id?: string;
  detectedAt?: string;
};

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 8);
}

function normalizeDecisionLogEntry(value: unknown): DecisionLogEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const whale = toNullableString(candidate.whale);
  const mint = toNullableString(candidate.mint);
  const mode = candidate.mode === "live" ? "live" : candidate.mode === "paper" ? "paper" : null;
  const category = candidate.category;
  const outcome = candidate.outcome;
  const detail = toNullableString(candidate.detail);
  const detectedAt = toNullableString(candidate.detectedAt);

  if (!whale || !mint || !mode || !detail || !detectedAt) {
    return null;
  }

  if (category !== "cluster" && category !== "entry" && category !== "paper" && category !== "live") {
    return null;
  }

  const allowedOutcomes: DecisionLogOutcome[] = [
    "cluster-floor-blocked",
    "paper-bypass",
    "paper-signal-blocked",
    "entry-rejected",
    "paper-opened",
    "paper-entry-missing",
    "live-skipped-active-position",
    "live-blocked",
    "live-sizing-blocked",
    "live-opened",
    "live-buy-failed",
  ];

  if (!allowedOutcomes.includes(outcome as DecisionLogOutcome)) {
    return null;
  }

  return {
    id: toNullableString(candidate.id) ?? `${detectedAt}:${whale}:${mint}:${String(outcome)}`,
    detectedAt,
    category,
    outcome: outcome as DecisionLogOutcome,
    whale,
    mint,
    mode,
    detail,
    reasons: toStringArray(candidate.reasons),
    notes: toStringArray(candidate.notes),
    signature: toNullableString(candidate.signature),
    performanceTier: toNullableString(candidate.performanceTier),
    sampleSize: toNullableNumber(candidate.sampleSize),
    signalClass: toNullableString(candidate.signalClass),
    signalStrategy: toNullableString(candidate.signalStrategy),
    clusterWalletCount: toNullableNumber(candidate.clusterWalletCount),
    clusterPremiumWalletCount: toNullableNumber(candidate.clusterPremiumWalletCount),
    clusterInsiderWalletCount: toNullableNumber(candidate.clusterInsiderWalletCount),
    whaleBuySizeSol: toNullableNumber(candidate.whaleBuySizeSol),
    whaleBuySizeUsd: toNullableNumber(candidate.whaleBuySizeUsd),
    liquidityUsd: toNullableNumber(candidate.liquidityUsd),
    entryPrice: toNullableNumber(candidate.entryPrice),
    entryPriceSource: toNullableString(candidate.entryPriceSource),
    priceExtensionPct: toNullableNumber(candidate.priceExtensionPct),
    expectedNetProfitPct: toNullableNumber(candidate.expectedNetProfitPct),
    rewardRiskRatio: toNullableNumber(candidate.rewardRiskRatio),
    dexId: toNullableString(candidate.dexId),
    poolAddress: toNullableString(candidate.poolAddress),
    preferredExecutionMode: toNullableString(candidate.preferredExecutionMode),
    buyAttemptCount: toNullableNumber(candidate.buyAttemptCount),
    errorMessage: toNullableString(candidate.errorMessage),
  };
}

function normalizeDecisionLog(value: unknown): DecisionLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeDecisionLogEntry)
    .filter((entry): entry is DecisionLogEntry => entry !== null)
    .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
    .slice(0, MAX_DECISION_LOG_ENTRIES);
}

export function readDecisionLog(limit?: number): DecisionLogEntry[] {
  const entries = normalizeDecisionLog(readJsonFileSync<unknown[]>(DECISION_LOG_PATH, []));
  return typeof limit === "number" ? entries.slice(0, Math.max(0, limit)) : entries;
}

export function writeDecisionLog(entries: DecisionLogEntry[]): void {
  writeJsonFileSync(DECISION_LOG_PATH, normalizeDecisionLog(entries));
}

export function appendDecisionLog(entry: DecisionLogEntryInput): DecisionLogEntry {
  const nextEntry = normalizeDecisionLogEntry({
    ...entry,
    id: entry.id ?? `${entry.detectedAt ?? new Date().toISOString()}:${entry.mode}:${entry.whale}:${entry.mint}:${entry.outcome}`,
    detectedAt: entry.detectedAt ?? new Date().toISOString(),
  });

  if (!nextEntry) {
    throw new Error("Invalid decision log entry.");
  }

  const entries = readDecisionLog();
  entries.unshift(nextEntry);
  writeDecisionLog(entries);
  return nextEntry;
}

export function clearDecisionLog(): void {
  writeDecisionLog([]);
}