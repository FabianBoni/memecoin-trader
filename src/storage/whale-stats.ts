import path from 'path';
import { fileURLToPath } from 'url';
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

export function readWhaleStats(): WhaleStatsStore {
  const raw = readJsonFileSync<Record<string, unknown>>(WHALE_STATS_PATH, {});
  const normalized: WhaleStatsStore = {};

  for (const [address, value] of Object.entries(raw)) {
    normalized[address] = normalizeStatsRecord(value);
  }

  return normalized;
}

export function writeWhaleStats(store: WhaleStatsStore) {
  writeJsonFileSync(WHALE_STATS_PATH, store);
}

export function appendWhaleTradeMetric(address: string, mode: WhaleTradeMode, metric: WhaleTradeMetricInput) {
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
