import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { loadApprovals } from "../storage/approvals.js";
import { getDatabase, isDatabaseEnabled, loadJsonDocumentSync } from "../storage/database.js";
import { readRuntimeStatus } from "../storage/runtime-status.js";
import { loadTradePlans } from "../storage/trades.js";
import { readWhaleStats } from "../storage/whale-stats.js";
import { readWhales } from "../storage/whales.js";

type ImportSummary = {
  label: string;
  count: number;
  sourcePath: string;
  existsOnDisk: boolean;
};

type CountRow = {
  count: number;
};

type SchemaVersionRow = {
  value: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DATA_DIR = path.resolve(SCRIPT_DIR, "../data");
const STORE_DIR = path.resolve(process.cwd(), env.STORE_PATH);

function relativePath(filePath: string): string {
  return path.relative(process.cwd(), filePath).replaceAll("\\", "/") || ".";
}

function countEntries(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }

  return 0;
}

function importSnapshot<T>(label: string, filePath: string, fallback: T): ImportSummary {
  const existsOnDisk = fs.existsSync(filePath);
  const value = loadJsonDocumentSync(filePath, fallback);

  return {
    label,
    count: countEntries(value),
    sourcePath: filePath,
    existsOnDisk,
  };
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    throw new Error("DATABASE_PATH is empty. Set DATABASE_PATH in .env before running db:init.");
  }

  const databasePath = path.resolve(process.cwd(), env.DATABASE_PATH);
  const existedBefore = fs.existsSync(databasePath);
  const db = getDatabase();
  const schemaVersion = (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as SchemaVersionRow | undefined)?.value ?? "unknown";
  const tableCount = (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as CountRow | undefined)?.count ?? 0;
  const journalMode = String(db.pragma("journal_mode", { simple: true }) ?? "unknown").toUpperCase();

  const summaries: ImportSummary[] = [
    {
      label: "runtime-status",
      count: Object.keys(readRuntimeStatus()).length,
      sourcePath: path.join(SRC_DATA_DIR, "runtime-status.json"),
      existsOnDisk: fs.existsSync(path.join(SRC_DATA_DIR, "runtime-status.json")),
    },
    {
      label: "whales",
      count: readWhales().length,
      sourcePath: path.join(SRC_DATA_DIR, "whales.json"),
      existsOnDisk: fs.existsSync(path.join(SRC_DATA_DIR, "whales.json")),
    },
    {
      label: "whale-stats",
      count: Object.keys(readWhaleStats()).length,
      sourcePath: path.join(SRC_DATA_DIR, "whale-stats.json"),
      existsOnDisk: fs.existsSync(path.join(SRC_DATA_DIR, "whale-stats.json")),
    },
    importSnapshot("active-trades", path.join(SRC_DATA_DIR, "active-trades.json"), {}),
    importSnapshot("paper-trades", path.join(SRC_DATA_DIR, "paper-trades.json"), {}),
    importSnapshot("trade-history", path.join(SRC_DATA_DIR, "trade-history.json"), []),
    importSnapshot("whale-activity", path.join(SRC_DATA_DIR, "whale-activity.json"), []),
    importSnapshot("scout-candidate-cache", path.join(SRC_DATA_DIR, "scout-candidate-cache.json"), {}),
    importSnapshot("performance", path.join(SRC_DATA_DIR, "performance.json"), {}),
    importSnapshot("paper-performance", path.join(SRC_DATA_DIR, "paper-performance.json"), {}),
    {
      label: "trade-plans",
      count: (await loadTradePlans()).length,
      sourcePath: path.join(STORE_DIR, "trade-plans.json"),
      existsOnDisk: fs.existsSync(path.join(STORE_DIR, "trade-plans.json")),
    },
    {
      label: "approvals",
      count: (await loadApprovals()).length,
      sourcePath: path.join(STORE_DIR, "approvals.json"),
      existsOnDisk: fs.existsSync(path.join(STORE_DIR, "approvals.json")),
    },
    importSnapshot("watchlist", path.join(STORE_DIR, "watchlist.json"), []),
  ];

  console.log(`[DB] ${existedBefore ? "Opened" : "Created"} SQLite database at ${databasePath}`);
  console.log(`[DB] schema_version=${schemaVersion} journal_mode=${journalMode} tables=${tableCount}`);
  console.log(`[DB] DATABASE_AUTO_MIGRATE=${String(env.DATABASE_AUTO_MIGRATE)} STORE_PATH=${STORE_DIR}`);

  for (const summary of summaries) {
    console.log(
      `[DB] ${summary.label}: ${summary.count} <- ${relativePath(summary.sourcePath)}${summary.existsOnDisk ? "" : " (missing on disk)"}`,
    );
  }

  console.log("[DB] Initialization complete.");
}

main().catch((error) => {
  console.error("[DB] Initialization failed:", error);
  process.exit(1);
});