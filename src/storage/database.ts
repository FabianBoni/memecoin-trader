import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env.js";
import { resolveConfiguredPath, resolveRepoPath, resolveSrcDataPath } from "../utils/repo-paths.js";

const SCHEMA_PATH = resolveRepoPath("db", "schema.sql");

let databaseInstance: Database.Database | null = null;

type JsonDocumentRow = {
  payload_json: string;
};

type TrackedPositionRow = {
  position_key: string;
  mint: string | null;
  payload_json: string;
};

type PayloadArrayRow = {
  payload_json: string;
};

type WhalePerformanceSnapshotRow = {
  whale_address: string;
  history_json: string;
};

type ScoutRejectedCandidateRow = {
  wallet_address: string;
  payload_json: string;
};

type SpecialJsonDocumentKind =
  | "active-trades"
  | "paper-trades"
  | "trade-history"
  | "whale-activity"
  | "performance"
  | "paper-performance"
  | "scout-candidate-cache";

type SpecialJsonLoadResult<T> = {
  found: boolean;
  value: T;
};

const SPECIAL_JSON_DOCUMENT_KIND_BY_PATH: Partial<Record<string, SpecialJsonDocumentKind>> = {
  [normalizeFilePath(resolveSrcDataPath("active-trades.json"))]: "active-trades",
  [normalizeFilePath(resolveSrcDataPath("paper-trades.json"))]: "paper-trades",
  [normalizeFilePath(resolveSrcDataPath("trade-history.json"))]: "trade-history",
  [normalizeFilePath(resolveSrcDataPath("whale-activity.json"))]: "whale-activity",
  [normalizeFilePath(resolveSrcDataPath("performance.json"))]: "performance",
  [normalizeFilePath(resolveSrcDataPath("paper-performance.json"))]: "paper-performance",
  [normalizeFilePath(resolveSrcDataPath("scout-candidate-cache.json"))]: "scout-candidate-cache",
};

function nowIso(): string {
  return new Date().toISOString();
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function resolveDatabasePath(): string {
  return resolveConfiguredPath(env.DATABASE_PATH);
}

function normalizeFilePath(filePath: string): string {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function resolveDocumentKey(filePath: string): string {
  return normalizeFilePath(filePath);
}

function getSpecialJsonDocumentKind(filePath: string): SpecialJsonDocumentKind | null {
  return SPECIAL_JSON_DOCUMENT_KIND_BY_PATH[normalizeFilePath(filePath)] ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(payloadJson: string, context: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    console.warn(`JSON parse fallback for ${context}:`, error);
    return null;
  }
}

function normalizeRecordStore(value: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainObject(value)) {
    return {};
  }

  const store: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) {
      store[key] = entry;
    }
  }

  return store;
}

function normalizeObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isPlainObject);
}

function normalizeBooleanHistory(value: unknown): boolean[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is boolean => typeof entry === "boolean");
}

function normalizeBooleanHistoryStore(value: unknown): Record<string, boolean[]> {
  if (!isPlainObject(value)) {
    return {};
  }

  const store: Record<string, boolean[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry)) {
      continue;
    }

    store[key] = normalizeBooleanHistory(entry);
  }

  return store;
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampFraction(value: unknown, fallback = 1): number {
  const parsed = toFiniteNumber(value);
  if (parsed === null) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

function getTrackedPositionRemainingFraction(payload: Record<string, unknown>): number {
  const remainingFraction = toFiniteNumber(payload.remainingPositionFraction);
  if (remainingFraction !== null) {
    return clampFraction(remainingFraction);
  }

  const realizedSoldFraction = toFiniteNumber(payload.realizedSoldFraction);
  if (realizedSoldFraction !== null) {
    return clampFraction(1 - realizedSoldFraction);
  }

  const whaleSoldFraction = toFiniteNumber(payload.whaleSoldFraction);
  if (whaleSoldFraction !== null) {
    return clampFraction(1 - whaleSoldFraction);
  }

  return 1;
}

function loadTrackedPositionStoreFromDatabase(mode: "live" | "paper"): SpecialJsonLoadResult<Record<string, Record<string, unknown>>> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT position_key, mint, payload_json
    FROM tracked_positions
    WHERE mode = ?
    ORDER BY COALESCE(opened_at, '') DESC, position_key ASC
  `).all(mode) as TrackedPositionRow[];

  if (rows.length === 0) {
    return { found: false, value: {} };
  }

  const store: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json, `tracked position ${row.position_key}`);
    if (!payload) {
      continue;
    }

    const keyPrefix = `${mode}:`;
    const fallbackKey = row.position_key.startsWith(keyPrefix)
      ? row.position_key.slice(keyPrefix.length)
      : row.position_key;
    const key = mode === "paper"
      ? (typeof payload.id === "string" ? payload.id : fallbackKey)
      : (typeof payload.mint === "string" ? payload.mint : (row.mint ?? fallbackKey));

    store[key] = payload;
  }

  return { found: true, value: store };
}

function saveTrackedPositionStoreToDatabase(mode: "live" | "paper", value: unknown): void {
  const db = getDatabase();
  const entries = Object.entries(normalizeRecordStore(value));
  const replacePositions = db.transaction((targetMode: "live" | "paper", targetEntries: Array<[string, Record<string, unknown>]>) => {
    db.prepare("DELETE FROM tracked_positions WHERE mode = ?").run(targetMode);

    const insert = db.prepare(`
      INSERT INTO tracked_positions (
        position_key,
        mint,
        whale_address,
        mode,
        status,
        opened_at,
        position_sol,
        remaining_position_fraction,
        payload_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, payload] of targetEntries) {
      insert.run(
        `${targetMode}:${key}`,
        typeof payload.mint === "string" ? payload.mint : key,
        typeof payload.whale === "string" ? payload.whale : null,
        targetMode,
        typeof payload.status === "string" ? payload.status : "open",
        typeof payload.openedAt === "string" ? payload.openedAt : nowIso(),
        toFiniteNumber(payload.positionSol ?? payload.sizeSol) ?? 0,
        getTrackedPositionRemainingFraction(payload),
        serializeJson(payload),
        nowIso(),
      );
    }
  });

  replacePositions(mode, entries);
}

function loadPayloadArrayFromDatabase(query: string, context: string): SpecialJsonLoadResult<Array<Record<string, unknown>>> {
  const db = getDatabase();
  const rows = db.prepare(query).all() as PayloadArrayRow[];
  if (rows.length === 0) {
    return { found: false, value: [] };
  }

  const values = rows.flatMap((row) => {
    const payload = parseJsonObject(row.payload_json, context);
    return payload ? [payload] : [];
  });

  return { found: true, value: values };
}

function saveTradeHistoryToDatabase(value: unknown): void {
  const db = getDatabase();
  const entries = normalizeObjectArray(value);
  const replaceHistory = db.transaction((targetEntries: Array<Record<string, unknown>>) => {
    db.prepare("DELETE FROM trade_history").run();

    const insert = db.prepare(`
      INSERT INTO trade_history (mint, mode, closed_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (let index = targetEntries.length - 1; index >= 0; index -= 1) {
      const entry = targetEntries[index] ?? {};
      const createdAt = typeof entry.closedAt === "string"
        ? entry.closedAt
        : typeof entry.detectedAt === "string"
          ? entry.detectedAt
          : typeof entry.openedAt === "string"
            ? entry.openedAt
            : nowIso();

      insert.run(
        typeof entry.mint === "string" ? entry.mint : null,
        typeof entry.mode === "string" ? entry.mode : null,
        typeof entry.closedAt === "string" ? entry.closedAt : null,
        serializeJson(entry),
        createdAt,
      );
    }
  });

  replaceHistory(entries);
}

function saveWhaleActivityToDatabase(value: unknown): void {
  const db = getDatabase();
  const entries = normalizeObjectArray(value);
  const replaceActivity = db.transaction((targetEntries: Array<Record<string, unknown>>) => {
    db.prepare("DELETE FROM whale_activity").run();

    const insert = db.prepare(`
      INSERT INTO whale_activity (whale_address, mint, activity_type, detected_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (let index = targetEntries.length - 1; index >= 0; index -= 1) {
      const entry = targetEntries[index] ?? {};
      const detectedAt = typeof entry.detectedAt === "string" ? entry.detectedAt : nowIso();

      insert.run(
        typeof entry.whale === "string" ? entry.whale : null,
        typeof entry.mint === "string" ? entry.mint : null,
        typeof entry.side === "string" ? entry.side : null,
        detectedAt,
        serializeJson(entry),
        detectedAt,
      );
    }
  });

  replaceActivity(entries);
}

function loadPerformanceSnapshotFromDatabase(mode: "live" | "paper"): SpecialJsonLoadResult<Record<string, boolean[]>> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT whale_address, history_json
    FROM whale_performance_snapshots
    WHERE mode = ?
    ORDER BY updated_at DESC, whale_address ASC
  `).all(mode) as WhalePerformanceSnapshotRow[];

  if (rows.length === 0) {
    return { found: false, value: {} };
  }

  const store: Record<string, boolean[]> = {};
  for (const row of rows) {
    try {
      store[row.whale_address] = normalizeBooleanHistory(JSON.parse(row.history_json) as unknown);
    } catch (error) {
      console.warn(`JSON parse fallback for performance snapshot ${row.whale_address}:${mode}:`, error);
      store[row.whale_address] = [];
    }
  }

  return { found: true, value: store };
}

function savePerformanceSnapshotToDatabase(mode: "live" | "paper", value: unknown): void {
  const db = getDatabase();
  const entries = Object.entries(normalizeBooleanHistoryStore(value));
  const replaceSnapshots = db.transaction((targetMode: "live" | "paper", targetEntries: Array<[string, boolean[]]>) => {
    db.prepare("DELETE FROM whale_performance_snapshots WHERE mode = ?").run(targetMode);

    const insert = db.prepare(`
      INSERT INTO whale_performance_snapshots (whale_address, mode, history_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);

    for (const [whaleAddress, history] of targetEntries) {
      insert.run(whaleAddress, targetMode, serializeJson(history), nowIso());
    }
  });

  replaceSnapshots(mode, entries);
}

function loadRejectedScoutCandidatesFromDatabase(): SpecialJsonLoadResult<Record<string, Record<string, unknown>>> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT wallet_address, payload_json
    FROM scout_rejected_candidates
    ORDER BY COALESCE(expires_at, rejected_at, '') DESC, wallet_address ASC
  `).all() as ScoutRejectedCandidateRow[];

  if (rows.length === 0) {
    return { found: false, value: {} };
  }

  const store: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json, `scout candidate ${row.wallet_address}`);
    if (!payload) {
      continue;
    }

    const key = typeof payload.address === "string" ? payload.address : row.wallet_address;
    store[key] = payload;
  }

  return { found: true, value: store };
}

function saveRejectedScoutCandidatesToDatabase(value: unknown): void {
  const db = getDatabase();
  const entries = Object.entries(normalizeRecordStore(value));
  const replaceRejectedCandidates = db.transaction((targetEntries: Array<[string, Record<string, unknown>]>) => {
    db.prepare("DELETE FROM scout_rejected_candidates").run();

    const insert = db.prepare(`
      INSERT INTO scout_rejected_candidates (
        wallet_address,
        mint_address,
        reason,
        rejected_at,
        expires_at,
        payload_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, entry] of targetEntries) {
      insert.run(
        typeof entry.address === "string" ? entry.address : key,
        typeof entry.lastSeedToken === "string"
          ? entry.lastSeedToken
          : (typeof entry.mintAddress === "string" ? entry.mintAddress : null),
        typeof entry.lastRejectReason === "string"
          ? entry.lastRejectReason
          : (typeof entry.reason === "string" ? entry.reason : "unknown"),
        typeof entry.lastRejectedAt === "string" ? entry.lastRejectedAt : nowIso(),
        typeof entry.rejectUntil === "string" ? entry.rejectUntil : null,
        serializeJson(entry),
        nowIso(),
      );
    }
  });

  replaceRejectedCandidates(entries);
}

function loadSpecialJsonDocumentSync<T>(filePath: string): SpecialJsonLoadResult<T> | null {
  const kind = getSpecialJsonDocumentKind(filePath);
  if (!kind) {
    return null;
  }

  switch (kind) {
    case "active-trades":
      return loadTrackedPositionStoreFromDatabase("live") as SpecialJsonLoadResult<T>;
    case "paper-trades":
      return loadTrackedPositionStoreFromDatabase("paper") as SpecialJsonLoadResult<T>;
    case "trade-history":
      return loadPayloadArrayFromDatabase(`
        SELECT payload_json
        FROM trade_history
        ORDER BY COALESCE(closed_at, created_at, '') DESC, id DESC
      `, "trade history") as SpecialJsonLoadResult<T>;
    case "whale-activity":
      return loadPayloadArrayFromDatabase(`
        SELECT payload_json
        FROM whale_activity
        ORDER BY COALESCE(detected_at, created_at, '') DESC, id DESC
      `, "whale activity") as SpecialJsonLoadResult<T>;
    case "performance":
      return loadPerformanceSnapshotFromDatabase("live") as SpecialJsonLoadResult<T>;
    case "paper-performance":
      return loadPerformanceSnapshotFromDatabase("paper") as SpecialJsonLoadResult<T>;
    case "scout-candidate-cache":
      return loadRejectedScoutCandidatesFromDatabase() as SpecialJsonLoadResult<T>;
    default:
      return null;
  }
}

function saveSpecialJsonDocumentSync(filePath: string, value: unknown): boolean {
  const kind = getSpecialJsonDocumentKind(filePath);
  if (!kind) {
    return false;
  }

  switch (kind) {
    case "active-trades":
      saveTrackedPositionStoreToDatabase("live", value);
      return true;
    case "paper-trades":
      saveTrackedPositionStoreToDatabase("paper", value);
      return true;
    case "trade-history":
      saveTradeHistoryToDatabase(value);
      return true;
    case "whale-activity":
      saveWhaleActivityToDatabase(value);
      return true;
    case "performance":
      savePerformanceSnapshotToDatabase("live", value);
      return true;
    case "paper-performance":
      savePerformanceSnapshotToDatabase("paper", value);
      return true;
    case "scout-candidate-cache":
      saveRejectedScoutCandidatesToDatabase(value);
      return true;
    default:
      return false;
  }
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureSchema(db: Database.Database): void {
  if (!env.DATABASE_AUTO_MIGRATE) {
    return;
  }

  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
}

export function isDatabaseEnabled(): boolean {
  return env.DATABASE_PATH.trim().length > 0;
}

export function getDatabase(): Database.Database {
  if (!isDatabaseEnabled()) {
    throw new Error("Database support is disabled because DATABASE_PATH is empty.");
  }

  if (databaseInstance) {
    return databaseInstance;
  }

  const databasePath = resolveDatabasePath();
  ensureParentDirectory(databasePath);

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${env.DATABASE_BUSY_TIMEOUT_MS}`);
  ensureSchema(db);

  databaseInstance = db;
  return db;
}

export function readJsonFileFromDiskSync<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      if (raw.trim().length === 0) {
        return fallback;
      }

      return JSON.parse(raw) as T;
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt === 1) {
        console.warn(`JSON read fallback for ${filePath}:`, error);
        return fallback;
      }
    }
  }

  return fallback;
}

export function writeJsonFileToDiskSync<T>(filePath: string, value: T): void {
  ensureParentDirectory(filePath);

  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, serializeJson(value) + "\n", "utf8");
  fs.renameSync(tempPath, filePath);
}

function upsertJsonDocument(db: Database.Database, filePath: string, value: unknown): void {
  const statement = db.prepare(`
    INSERT INTO json_documents (document_key, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(document_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  statement.run(resolveDocumentKey(filePath), serializeJson(value), nowIso());
}

export function loadJsonDocumentFromDatabaseSync<T>(filePath: string): T | undefined {
  if (!isDatabaseEnabled()) {
    return undefined;
  }

  const specialResult = loadSpecialJsonDocumentSync<T>(filePath);
  if (specialResult) {
    return specialResult.found ? specialResult.value : undefined;
  }

  const row = getDatabase().prepare(`
    SELECT payload_json
    FROM json_documents
    WHERE document_key = ?
  `).get(resolveDocumentKey(filePath)) as JsonDocumentRow | undefined;

  if (!row) {
    return undefined;
  }

  try {
    return JSON.parse(row.payload_json) as T;
  } catch (error) {
    console.warn(`JSON document parse fallback for ${filePath}:`, error);
    return undefined;
  }
}

export function loadJsonDocumentSync<T>(filePath: string, fallback: T): T {
  if (!isDatabaseEnabled()) {
    return readJsonFileFromDiskSync(filePath, fallback);
  }

  const dbValue = loadJsonDocumentFromDatabaseSync<T>(filePath);
  if (dbValue !== undefined) {
    return dbValue;
  }

  const value = readJsonFileFromDiskSync(filePath, fallback);
  if (fs.existsSync(filePath)) {
    if (!saveSpecialJsonDocumentSync(filePath, value)) {
      upsertJsonDocument(getDatabase(), filePath, value);
    }
  }

  return value;
}

export function saveJsonDocumentSync<T>(filePath: string, value: T): void {
  if (isDatabaseEnabled()) {
    if (!saveSpecialJsonDocumentSync(filePath, value)) {
      upsertJsonDocument(getDatabase(), filePath, value);
    }
  }

  writeJsonFileToDiskSync(filePath, value);
}

export async function loadJsonDocument<T>(filePath: string, fallback: T): Promise<T> {
  return loadJsonDocumentSync(filePath, fallback);
}

export async function saveJsonDocument<T>(filePath: string, value: T): Promise<void> {
  saveJsonDocumentSync(filePath, value);
}