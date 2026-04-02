import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, isDatabaseEnabled } from './database.js';
import { readJsonFileSync, writeJsonFileSync } from './json-file-sync.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WHALE_STATS_PATH = path.resolve(SCRIPT_DIR, '../data/whale-stats.json');
const MAX_TRADE_METRICS = 50;
const MAX_DISCARD_METRICS = 50;

export type WhaleTradeMode = 'paper' | 'live';

export interface WhaleTradeMetric {
  closedAt: string;
  mint?: string;
  pnlPct: number;
  holdMinutes: number;
  exitReason: string;
  panicExit: boolean;
  hadPositiveExcursion: boolean;
  roundTripCostBps?: number | null;
}

export interface WhaleTradeMetricInput {
  closedAt?: string;
  mint?: string;
  pnlPct: number;
  holdMinutes?: number;
  exitReason?: string;
  panicExit?: boolean;
  hadPositiveExcursion?: boolean;
  roundTripCostBps?: number | null;
}

export interface WhaleTradeDiscard {
  discardedAt: string;
  reason: string;
  mint?: string;
}

export interface WhaleModeStats {
  trades: WhaleTradeMetric[];
  discards: WhaleTradeDiscard[];
}

export interface WhaleStatsRecord {
  paper: WhaleModeStats;
  live: WhaleModeStats;
}

export type WhaleStatsStore = Record<string, WhaleStatsRecord>;

export interface WhaleModeSummary {
  evaluatedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  panicExitRatePct: number | null;
  avgHoldMinutes: number | null;
  positiveExcursionRatePct: number | null;
  avgRoundTripCostBps: number | null;
  noPriceDiscards: number;
  streak: string;
}

type WhaleTradeMetricRow = {
  whale_address: string;
  mode: WhaleTradeMode;
  closed_at: string;
  mint: string | null;
  pnl_pct: number;
  hold_minutes: number;
  exit_reason: string;
  panic_exit: number;
  had_positive_excursion: number;
  round_trip_cost_bps: number | null;
};

type WhaleTradeDiscardRow = {
  whale_address: string;
  mode: WhaleTradeMode;
  discarded_at: string;
  reason: string;
  mint: string | null;
};

function emptyModeStats(): WhaleModeStats {
  return {
    trades: [],
    discards: [],
  };
}

function emptyStatsRecord(): WhaleStatsRecord {
  return {
    paper: emptyModeStats(),
    live: emptyModeStats(),
  };
}

function normalizeTradeMetric(input: unknown): WhaleTradeMetric | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const closedAt = typeof candidate.closedAt === 'string' ? candidate.closedAt : null;
  const pnlPct = Number(candidate.pnlPct);
  if (!closedAt || !Number.isFinite(pnlPct)) {
    return null;
  }

  return {
    closedAt,
    ...(typeof candidate.mint === 'string' ? { mint: candidate.mint } : {}),
    pnlPct,
    holdMinutes: Number.isFinite(Number(candidate.holdMinutes)) ? Number(candidate.holdMinutes) : 0,
    exitReason: typeof candidate.exitReason === 'string' ? candidate.exitReason : 'unknown',
    panicExit: candidate.panicExit === true,
    hadPositiveExcursion: candidate.hadPositiveExcursion === true,
    ...(candidate.roundTripCostBps === null || Number.isFinite(Number(candidate.roundTripCostBps))
      ? { roundTripCostBps: candidate.roundTripCostBps === null ? null : Number(candidate.roundTripCostBps) }
      : {}),
  };
}

function normalizeDiscard(input: unknown): WhaleTradeDiscard | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  if (typeof candidate.discardedAt !== 'string' || typeof candidate.reason !== 'string') {
    return null;
  }

  return {
    discardedAt: candidate.discardedAt,
    reason: candidate.reason,
    ...(typeof candidate.mint === 'string' ? { mint: candidate.mint } : {}),
  };
}

function normalizeModeStats(input: unknown): WhaleModeStats {
  if (!input || typeof input !== 'object') {
    return emptyModeStats();
  }

  const candidate = input as Record<string, unknown>;
  const trades = Array.isArray(candidate.trades)
    ? candidate.trades.map(normalizeTradeMetric).filter((item): item is WhaleTradeMetric => item !== null)
    : [];
  const discards = Array.isArray(candidate.discards)
    ? candidate.discards.map(normalizeDiscard).filter((item): item is WhaleTradeDiscard => item !== null)
    : [];

  return {
    trades,
    discards,
  };
}

function normalizeStatsRecord(input: unknown): WhaleStatsRecord {
  if (!input || typeof input !== 'object') {
    return emptyStatsRecord();
  }

  const candidate = input as Record<string, unknown>;
  return {
    paper: normalizeModeStats(candidate.paper),
    live: normalizeModeStats(candidate.live),
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }

  return sorted[middle] ?? null;
}

function ensureStatsRecord(store: WhaleStatsStore, address: string): WhaleStatsRecord {
  const existing = store[address];
  if (existing) {
    return existing;
  }

  const nextRecord = emptyStatsRecord();
  store[address] = nextRecord;
  return nextRecord;
}

function readWhaleStatsFromDatabase(): WhaleStatsStore {
  const db = getDatabase();
  const tradeRows = db.prepare(`
    SELECT whale_address, mode, closed_at, mint, pnl_pct, hold_minutes, exit_reason, panic_exit, had_positive_excursion, round_trip_cost_bps
    FROM whale_trade_metrics
    ORDER BY whale_address ASC, mode ASC, closed_at ASC, id ASC
  `).all() as WhaleTradeMetricRow[];
  const discardRows = db.prepare(`
    SELECT whale_address, mode, discarded_at, reason, mint
    FROM whale_trade_discards
    ORDER BY whale_address ASC, mode ASC, discarded_at ASC, id ASC
  `).all() as WhaleTradeDiscardRow[];

  if (tradeRows.length === 0 && discardRows.length === 0) {
    const legacyRaw = readJsonFileSync<Record<string, unknown>>(WHALE_STATS_PATH, {});
    const legacyStore: WhaleStatsStore = {};
    for (const [address, value] of Object.entries(legacyRaw)) {
      legacyStore[address] = normalizeStatsRecord(value);
    }

    if (Object.keys(legacyStore).length > 0) {
      writeWhaleStats(legacyStore);
      return legacyStore;
    }
  }

  const store: WhaleStatsStore = {};
  for (const row of tradeRows) {
    const statsRecord = ensureStatsRecord(store, row.whale_address);
    statsRecord[row.mode].trades.push({
      closedAt: row.closed_at,
      ...(row.mint ? { mint: row.mint } : {}),
      pnlPct: row.pnl_pct,
      holdMinutes: row.hold_minutes,
      exitReason: row.exit_reason,
      panicExit: row.panic_exit === 1,
      hadPositiveExcursion: row.had_positive_excursion === 1,
      ...(row.round_trip_cost_bps === null ? { roundTripCostBps: null } : { roundTripCostBps: row.round_trip_cost_bps }),
    });
  }

  for (const row of discardRows) {
    const statsRecord = ensureStatsRecord(store, row.whale_address);
    statsRecord[row.mode].discards.push({
      discardedAt: row.discarded_at,
      reason: row.reason,
      ...(row.mint ? { mint: row.mint } : {}),
    });
  }

  return store;
}

function trimWhaleTradeMetrics(address: string, mode: WhaleTradeMode): void {
  const db = getDatabase();
  db.prepare(`
    DELETE FROM whale_trade_metrics
    WHERE whale_address = ?
      AND mode = ?
      AND id NOT IN (
        SELECT id
        FROM whale_trade_metrics
        WHERE whale_address = ?
          AND mode = ?
        ORDER BY closed_at DESC, id DESC
        LIMIT ?
      )
  `).run(address, mode, address, mode, MAX_TRADE_METRICS);
}

function trimWhaleTradeDiscards(address: string, mode: WhaleTradeMode): void {
  const db = getDatabase();
  db.prepare(`
    DELETE FROM whale_trade_discards
    WHERE whale_address = ?
      AND mode = ?
      AND id NOT IN (
        SELECT id
        FROM whale_trade_discards
        WHERE whale_address = ?
          AND mode = ?
        ORDER BY discarded_at DESC, id DESC
        LIMIT ?
      )
  `).run(address, mode, address, mode, MAX_DISCARD_METRICS);
}

export function readWhaleStats(): WhaleStatsStore {
  if (isDatabaseEnabled()) {
    return readWhaleStatsFromDatabase();
  }

  const raw = readJsonFileSync<Record<string, unknown>>(WHALE_STATS_PATH, {});
  const normalized: WhaleStatsStore = {};

  for (const [address, value] of Object.entries(raw)) {
    normalized[address] = normalizeStatsRecord(value);
  }

  return normalized;
}

export function writeWhaleStats(store: WhaleStatsStore) {
  if (isDatabaseEnabled()) {
    const db = getDatabase();
    const normalizedEntries = Object.entries(store).map(([address, value]) => [address, normalizeStatsRecord(value)] as const);
    const replaceAll = db.transaction((entries: ReadonlyArray<readonly [string, WhaleStatsRecord]>) => {
      db.prepare('DELETE FROM whale_trade_metrics').run();
      db.prepare('DELETE FROM whale_trade_discards').run();

      const insertMetric = db.prepare(`
        INSERT INTO whale_trade_metrics (
          whale_address,
          mode,
          closed_at,
          mint,
          pnl_pct,
          hold_minutes,
          exit_reason,
          panic_exit,
          had_positive_excursion,
          round_trip_cost_bps,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertDiscard = db.prepare(`
        INSERT INTO whale_trade_discards (
          whale_address,
          mode,
          discarded_at,
          reason,
          mint,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const [address, value] of entries) {
        for (const mode of ['paper', 'live'] as const) {
          for (const trade of value[mode].trades) {
            insertMetric.run(
              address,
              mode,
              trade.closedAt,
              trade.mint ?? null,
              trade.pnlPct,
              trade.holdMinutes,
              trade.exitReason,
              trade.panicExit ? 1 : 0,
              trade.hadPositiveExcursion ? 1 : 0,
              trade.roundTripCostBps ?? null,
              trade.closedAt,
            );
          }

          for (const discard of value[mode].discards) {
            insertDiscard.run(
              address,
              mode,
              discard.discardedAt,
              discard.reason,
              discard.mint ?? null,
              discard.discardedAt,
            );
          }
        }
      }
    });

    replaceAll(normalizedEntries);
    writeJsonFileSync(WHALE_STATS_PATH, Object.fromEntries(normalizedEntries));
    return;
  }

  writeJsonFileSync(WHALE_STATS_PATH, store);
}

export function appendWhaleTradeMetric(address: string, mode: WhaleTradeMode, metric: WhaleTradeMetricInput) {
  if (isDatabaseEnabled()) {
    const db = getDatabase();
    const appendMetric = db.transaction((targetAddress: string, targetMode: WhaleTradeMode, targetMetric: WhaleTradeMetricInput) => {
      db.prepare(`
        INSERT INTO whale_trade_metrics (
          whale_address,
          mode,
          closed_at,
          mint,
          pnl_pct,
          hold_minutes,
          exit_reason,
          panic_exit,
          had_positive_excursion,
          round_trip_cost_bps,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        targetAddress,
        targetMode,
        targetMetric.closedAt ?? new Date().toISOString(),
        targetMetric.mint ?? null,
        targetMetric.pnlPct,
        targetMetric.holdMinutes ?? 0,
        targetMetric.exitReason ?? 'unknown',
        targetMetric.panicExit === true ? 1 : 0,
        targetMetric.hadPositiveExcursion === true ? 1 : 0,
        targetMetric.roundTripCostBps ?? null,
        targetMetric.closedAt ?? new Date().toISOString(),
      );
      trimWhaleTradeMetrics(targetAddress, targetMode);
    });

    appendMetric(address, mode, metric);
    return;
  }

  const store = readWhaleStats();
  const stats = store[address] ?? emptyStatsRecord();
  const modeStats = stats[mode];

  modeStats.trades.push({
    closedAt: metric.closedAt ?? new Date().toISOString(),
    ...(metric.mint ? { mint: metric.mint } : {}),
    pnlPct: metric.pnlPct,
    holdMinutes: metric.holdMinutes ?? 0,
    exitReason: metric.exitReason ?? 'unknown',
    panicExit: metric.panicExit === true,
    hadPositiveExcursion: metric.hadPositiveExcursion === true,
    ...(metric.roundTripCostBps === undefined ? {} : { roundTripCostBps: metric.roundTripCostBps }),
  });

  if (modeStats.trades.length > MAX_TRADE_METRICS) {
    modeStats.trades.splice(0, modeStats.trades.length - MAX_TRADE_METRICS);
  }

  store[address] = stats;
  writeWhaleStats(store);
}

export function appendWhaleTradeDiscard(address: string, mode: WhaleTradeMode, discard: Omit<WhaleTradeDiscard, 'discardedAt'> & { discardedAt?: string }) {
  if (isDatabaseEnabled()) {
    const db = getDatabase();
    const appendDiscard = db.transaction((targetAddress: string, targetMode: WhaleTradeMode, targetDiscard: Omit<WhaleTradeDiscard, 'discardedAt'> & { discardedAt?: string }) => {
      db.prepare(`
        INSERT INTO whale_trade_discards (
          whale_address,
          mode,
          discarded_at,
          reason,
          mint,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        targetAddress,
        targetMode,
        targetDiscard.discardedAt ?? new Date().toISOString(),
        targetDiscard.reason,
        targetDiscard.mint ?? null,
        targetDiscard.discardedAt ?? new Date().toISOString(),
      );
      trimWhaleTradeDiscards(targetAddress, targetMode);
    });

    appendDiscard(address, mode, discard);
    return;
  }

  const store = readWhaleStats();
  const stats = store[address] ?? emptyStatsRecord();
  const modeStats = stats[mode];

  modeStats.discards.push({
    discardedAt: discard.discardedAt ?? new Date().toISOString(),
    reason: discard.reason,
    ...(discard.mint ? { mint: discard.mint } : {}),
  });

  if (modeStats.discards.length > MAX_DISCARD_METRICS) {
    modeStats.discards.splice(0, modeStats.discards.length - MAX_DISCARD_METRICS);
  }

  store[address] = stats;
  writeWhaleStats(store);
}

export function buildWhaleModeSummary(store: WhaleStatsStore, address: string, mode: WhaleTradeMode): WhaleModeSummary {
  const modeStats = store[address]?.[mode] ?? emptyModeStats();
  const trades = modeStats.trades;
  const wins = trades.filter((trade) => trade.pnlPct > 0).length;
  const losses = trades.length - wins;
  const pnlValues = trades.map((trade) => trade.pnlPct);
  const holdValues = trades.map((trade) => trade.holdMinutes).filter((value) => Number.isFinite(value));
  const roundTripValues = trades
    .map((trade) => trade.roundTripCostBps)
    .filter((value): value is number => Number.isFinite(Number(value)));
  const panicCount = trades.filter((trade) => trade.panicExit).length;
  const positiveExcursions = trades.filter((trade) => trade.hadPositiveExcursion).length;

  return {
    evaluatedTrades: trades.length,
    wins,
    losses,
    winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : null,
    avgPnlPct: average(pnlValues),
    medianPnlPct: median(pnlValues),
    panicExitRatePct: trades.length > 0 ? (panicCount / trades.length) * 100 : null,
    avgHoldMinutes: average(holdValues),
    positiveExcursionRatePct: trades.length > 0 ? (positiveExcursions / trades.length) * 100 : null,
    avgRoundTripCostBps: average(roundTripValues),
    noPriceDiscards: modeStats.discards.filter((discard) => discard.reason === 'no-price').length,
    streak: trades.slice(-5).map((trade) => trade.pnlPct > 0 ? 'W' : 'L').join(' '),
  };
}

export function getWhaleModeSummary(address: string, mode: WhaleTradeMode): WhaleModeSummary {
  return buildWhaleModeSummary(readWhaleStats(), address, mode);
}

export function deleteWhaleStats(address: string): void {
  if (!isDatabaseEnabled()) {
    const store = readWhaleStats();
    delete store[address];
    writeWhaleStats(store);
    return;
  }

  const db = getDatabase();
  db.prepare('DELETE FROM whale_trade_metrics WHERE whale_address = ?').run(address);
  db.prepare('DELETE FROM whale_trade_discards WHERE whale_address = ?').run(address);
  writeJsonFileSync(WHALE_STATS_PATH, readWhaleStats());
}

export function clearWhaleStats(): void {
  if (!isDatabaseEnabled()) {
    writeWhaleStats({});
    return;
  }

  const db = getDatabase();
  db.prepare('DELETE FROM whale_trade_metrics').run();
  db.prepare('DELETE FROM whale_trade_discards').run();
  writeJsonFileSync(WHALE_STATS_PATH, {});
}

export function resetWhaleModeStats(mode: WhaleTradeMode, address?: string): void {
  if (!isDatabaseEnabled()) {
    const store = readWhaleStats();

    if (!address) {
      for (const value of Object.values(store)) {
        value[mode] = emptyModeStats();
      }
      writeWhaleStats(store);
      return;
    }

    const existing = store[address];
    if (!existing) {
      return;
    }

    existing[mode] = emptyModeStats();
    writeWhaleStats(store);
    return;
  }

  const db = getDatabase();
  if (address) {
    db.prepare('DELETE FROM whale_trade_metrics WHERE whale_address = ? AND mode = ?').run(address, mode);
    db.prepare('DELETE FROM whale_trade_discards WHERE whale_address = ? AND mode = ?').run(address, mode);
  } else {
    db.prepare('DELETE FROM whale_trade_metrics WHERE mode = ?').run(mode);
    db.prepare('DELETE FROM whale_trade_discards WHERE mode = ?').run(mode);
  }

  writeJsonFileSync(WHALE_STATS_PATH, readWhaleStats());
}
