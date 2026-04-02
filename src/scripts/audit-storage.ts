import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import {
  isDatabaseEnabled,
  loadJsonDocumentFromDatabaseSync,
  readJsonFileFromDiskSync,
} from "../storage/database.js";

type AuditTarget = {
  filePath: string;
  fallback: unknown;
};

type AuditResult = {
  filePath: string;
  ok: boolean;
  detail: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DATA_DIR = path.resolve(SCRIPT_DIR, "../data");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, normalizeValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (isPlainObject(value)) {
    return `object(${Object.keys(value).length})`;
  }

  return JSON.stringify(value);
}

function describeDifference(diskValue: unknown, dbValue: unknown): string {
  if (Array.isArray(diskValue) && Array.isArray(dbValue)) {
    if (diskValue.length !== dbValue.length) {
      return `array length ${diskValue.length} != ${dbValue.length}`;
    }

    for (let index = 0; index < diskValue.length; index += 1) {
      if (stableStringify(diskValue[index]) !== stableStringify(dbValue[index])) {
        return `first array mismatch at index ${index}`;
      }
    }

    return "array content mismatch";
  }

  if (isPlainObject(diskValue) && isPlainObject(dbValue)) {
    const diskKeys = Object.keys(diskValue).sort((left, right) => left.localeCompare(right));
    const dbKeys = Object.keys(dbValue).sort((left, right) => left.localeCompare(right));
    const missingKeys = diskKeys.filter((key) => !dbKeys.includes(key)).slice(0, 5);
    const extraKeys = dbKeys.filter((key) => !diskKeys.includes(key)).slice(0, 5);

    if (missingKeys.length > 0 || extraKeys.length > 0) {
      return `keys differ missing=${JSON.stringify(missingKeys)} extra=${JSON.stringify(extraKeys)}`;
    }

    for (const key of diskKeys) {
      if (stableStringify(diskValue[key]) !== stableStringify(dbValue[key])) {
        return `value mismatch at key ${key}`;
      }
    }

    return "object value mismatch";
  }

  return `disk=${summarizeValue(diskValue)} db=${summarizeValue(dbValue)}`;
}

function relativeFilePath(filePath: string): string {
  return path.relative(process.cwd(), filePath).replaceAll("\\", "/");
}

function auditTarget(target: AuditTarget): AuditResult {
  const diskValue = readJsonFileFromDiskSync(target.filePath, target.fallback);
  const dbValue = loadJsonDocumentFromDatabaseSync<unknown>(target.filePath) ?? target.fallback;
  const ok = stableStringify(diskValue) === stableStringify(dbValue);

  return {
    filePath: target.filePath,
    ok,
    detail: ok
      ? summarizeValue(diskValue)
      : describeDifference(diskValue, dbValue),
  };
}

function buildAuditTargets(): AuditTarget[] {
  return [
    { filePath: path.join(SRC_DATA_DIR, "runtime-status.json"), fallback: {} },
    { filePath: path.join(SRC_DATA_DIR, "whales.json"), fallback: [] },
    { filePath: path.join(SRC_DATA_DIR, "whale-stats.json"), fallback: {} },
    { filePath: path.join(SRC_DATA_DIR, "active-trades.json"), fallback: {} },
    { filePath: path.join(SRC_DATA_DIR, "paper-trades.json"), fallback: {} },
    { filePath: path.join(SRC_DATA_DIR, "trade-history.json"), fallback: [] },
    { filePath: path.join(SRC_DATA_DIR, "whale-activity.json"), fallback: [] },
    { filePath: path.join(SRC_DATA_DIR, "scout-candidate-cache.json"), fallback: {} },
    { filePath: path.join(SRC_DATA_DIR, "performance.json"), fallback: {} },
    { filePath: path.join(SRC_DATA_DIR, "paper-performance.json"), fallback: {} },
  ];
}

function main(): void {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_PATH is empty; storage audit requires the SQLite backend.");
  }

  const targets = buildAuditTargets();
  const results = targets.map((target) => auditTarget(target));
  const drifted = results.filter((result) => !result.ok);

  console.log(`[AUDIT] Checked ${results.length} storage snapshots.`);
  for (const result of results) {
    const status = result.ok ? "OK" : "DRIFT";
    console.log(`[${status}] ${relativeFilePath(result.filePath)} :: ${result.detail}`);
  }

  if (drifted.length > 0) {
    console.error(`[AUDIT] ${drifted.length} snapshot(s) differ from SQLite-backed state.`);
    process.exitCode = 1;
    return;
  }

  console.log("[AUDIT] All checked snapshots match SQLite-backed state.");
}

main();