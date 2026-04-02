import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { readJsonFileSync, writeJsonFileSync } from '../storage/json-file-sync.js';
import {
  appendWhaleTradeDiscard,
  appendWhaleTradeMetric,
  readWhaleStats,
  writeWhaleStats,
  type WhaleTradeMetricInput,
  type WhaleTradeMode,
} from '../storage/whale-stats.js';
import { normalizeWhales, type WhaleRecord } from '../storage/whales.js';
import { sendTelegram } from './telegram-notifier.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PERF_FILE = path.resolve(SCRIPT_DIR, '../data/performance.json');
const WHALE_FILE = path.resolve(SCRIPT_DIR, '../data/whales.json');
const PAPER_PERF_FILE = path.resolve(SCRIPT_DIR, '../data/paper-performance.json');
const PAPER_TRADES_FILE = path.resolve(SCRIPT_DIR, '../data/paper-trades.json');
const LEGACY_HISTORY_LIMIT = Math.max(env.PAPER_PROMOTION_MIN_TRADES, env.LIVE_ELIMINATION_MIN_TRADES, 12);
const PAPER_HARD_REJECTION_MAX_WIN_RATE_PCT = 20;
const PAPER_HARD_REJECTION_MAX_AVG_PNL_PCT = -10;
const PAPER_HARD_REJECTION_MAX_MEDIAN_PNL_PCT = -5;
const PAPER_EARLY_REJECTION_MAX_WIN_RATE_PCT = 30;
const PAPER_EARLY_REJECTION_MAX_AVG_PNL_PCT = -3;
const PAPER_EARLY_REJECTION_MAX_MEDIAN_PNL_PCT = -2;
const PAPER_EXTENDED_REVIEW_TRADES = Math.max(env.PAPER_PROMOTION_MIN_TRADES * 2, 16);
const PAPER_EXTENDED_REJECTION_MAX_WIN_RATE_PCT = 35;
const PAPER_EXTENDED_REJECTION_MAX_AVG_PNL_PCT = -2;
const PAPER_EXTENDED_REJECTION_MAX_MEDIAN_PNL_PCT = -0.5;
const PAPER_STAGNATION_REVIEW_TRADES = Math.max(Math.ceil(env.PAPER_PROMOTION_MIN_TRADES * 2.5), 20);
const PAPER_STAGNATION_MIN_WIN_RATE_PCT = Math.max(env.PAPER_PROMOTION_MIN_WIN_RATE_PCT - 5, 55);
const PAPER_STAGNATION_MIN_AVG_PNL_PCT = Math.max(1, env.PAPER_PROMOTION_MIN_AVG_PNL_PCT * 0.25);
const PAPER_STAGNATION_MIN_MEDIAN_PNL_PCT = Math.max(0.5, env.PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT * 0.25);
const PAPER_FINAL_STAGNATION_REVIEW_TRADES = Math.max(env.PAPER_PROMOTION_MIN_TRADES * 5, 40);
const PAPER_FINAL_STAGNATION_MIN_WIN_RATE_PCT = Math.max(env.PAPER_PROMOTION_MIN_WIN_RATE_PCT, 60);
const PAPER_FINAL_STAGNATION_MIN_AVG_PNL_PCT = Math.max(2, env.PAPER_PROMOTION_MIN_AVG_PNL_PCT * 0.5);
const PAPER_FINAL_STAGNATION_MIN_MEDIAN_PNL_PCT = Math.max(1, env.PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT * 0.5);
const PAPER_UNPROVEN_EXPIRY_HOURS = 24;
const PAPER_SLOW_START_EXPIRY_HOURS = 48;
const PAPER_SLOW_START_MIN_EVALUATED_TRADES = 3;

export interface WhalePerformanceInput extends WhaleTradeMetricInput {
  discardReason?: string | null;
}

function readLegacyPerformance(filePath: string) {
  return readJsonFileSync<Record<string, boolean[]>>(filePath, {});
}

function writeLegacyPerformance(filePath: string, data: Record<string, boolean[]>) {
  writeJsonFileSync(filePath, data);
}

function updateWhaleTradeCounts(address: string, field: 'paperTrades' | 'liveTrades', value: number) {
  const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
  const updatedWhales = whales.map((whale) => whale.address === address ? { ...whale, [field]: value } : whale);
  writeJsonFileSync(WHALE_FILE, updatedWhales);
}

function normalizePerformanceInput(input: boolean | WhalePerformanceInput): WhalePerformanceInput {
  if (typeof input === 'boolean') {
    return {
      pnlPct: input ? 1 : -1,
      exitReason: input ? 'legacy-win' : 'legacy-loss',
      holdMinutes: 0,
      panicExit: false,
      hadPositiveExcursion: input,
      roundTripCostBps: env.ESTIMATED_ROUND_TRIP_COST_BPS,
    };
  }

  return {
    ...input,
    holdMinutes: Number.isFinite(Number(input.holdMinutes)) ? Number(input.holdMinutes) : 0,
    exitReason: input.exitReason ?? 'unknown',
    panicExit: input.panicExit === true,
    hadPositiveExcursion: input.hadPositiveExcursion === true || input.pnlPct > 0,
    roundTripCostBps: input.roundTripCostBps ?? env.ESTIMATED_ROUND_TRIP_COST_BPS,
  };
}

function syncLegacyOutcome(filePath: string, whaleAddress: string, isWin: boolean) {
  const data = readLegacyPerformance(filePath);
  const history = Array.isArray(data[whaleAddress])
    ? data[whaleAddress].filter((value): value is boolean => typeof value === 'boolean')
    : [];

  history.push(isWin);
  if (history.length > LEGACY_HISTORY_LIMIT) {
    history.splice(0, history.length - LEGACY_HISTORY_LIMIT);
  }

  data[whaleAddress] = history;
  writeLegacyPerformance(filePath, data);
  return history;
}

function getRecentLossStreak(pnlHistory: number[]) {
  let streak = 0;
  for (let index = pnlHistory.length - 1; index >= 0; index -= 1) {
    const pnl = pnlHistory[index];
    if (pnl === undefined) {
      continue;
    }

    if (pnl > 0) {
      break;
    }

    streak += 1;
  }

  return streak;
}

function getModeMetrics(address: string, mode: WhaleTradeMode) {
  const store = readWhaleStats();
  const trades = store[address]?.[mode]?.trades ?? [];
  const discards = store[address]?.[mode]?.discards ?? [];
  const pnlHistory = trades.map((trade) => trade.pnlPct);
  const wins = pnlHistory.filter((value) => value > 0).length;
  const avgPnlPct = pnlHistory.length > 0
    ? pnlHistory.reduce((sum, value) => sum + value, 0) / pnlHistory.length
    : null;
  const sortedPnl = [...pnlHistory].sort((left, right) => left - right);
  const medianPnlPct = sortedPnl.length === 0
    ? null
    : sortedPnl.length % 2 === 0
      ? (((sortedPnl[(sortedPnl.length / 2) - 1] ?? 0) + (sortedPnl[sortedPnl.length / 2] ?? 0)) / 2)
      : (sortedPnl[Math.floor(sortedPnl.length / 2)] ?? null);

  return {
    trades,
    discards,
    evaluatedTrades: trades.length,
    wins,
    winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : null,
    avgPnlPct,
    medianPnlPct,
    lossStreak: getRecentLossStreak(pnlHistory),
  };
}

function syncWhaleTradeCounts(address: string) {
  const paper = getModeMetrics(address, 'paper');
  const live = getModeMetrics(address, 'live');
  updateWhaleTradeCounts(address, 'paperTrades', paper.evaluatedTrades);
  updateWhaleTradeCounts(address, 'liveTrades', live.evaluatedTrades);
}

function isPaperPromotionReady(summary: ReturnType<typeof getModeMetrics>): boolean {
  return (summary.winRatePct ?? 0) >= env.PAPER_PROMOTION_MIN_WIN_RATE_PCT
    && (summary.avgPnlPct ?? Number.NEGATIVE_INFINITY) >= env.PAPER_PROMOTION_MIN_AVG_PNL_PCT
    && (summary.medianPnlPct ?? Number.NEGATIVE_INFINITY) >= env.PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT;
}

function getWhaleAgeHours(whale: WhaleRecord): number | null {
  const referenceTimestamp = whale.discoveredAt ?? whale.lastScoutedAt;
  if (!referenceTimestamp) {
    return null;
  }

  const discoveredAt = Date.parse(referenceTimestamp);
  if (!Number.isFinite(discoveredAt)) {
    return null;
  }

  return (Date.now() - discoveredAt) / (1000 * 60 * 60);
}

function getPaperExpiryReason(whale: WhaleRecord, summary: ReturnType<typeof getModeMetrics>): string | null {
  const whaleAgeHours = getWhaleAgeHours(whale);
  if (whaleAgeHours === null || whaleAgeHours < PAPER_UNPROVEN_EXPIRY_HOURS) {
    return null;
  }

  if (summary.evaluatedTrades === 0) {
    return `Keine ausgewerteten Trades nach ${Math.round(whaleAgeHours)}h seit Discovery`;
  }

  if (whaleAgeHours >= PAPER_SLOW_START_EXPIRY_HOURS && summary.evaluatedTrades < PAPER_SLOW_START_MIN_EVALUATED_TRADES) {
    return `Nur ${summary.evaluatedTrades} ausgewertete Trades nach ${Math.round(whaleAgeHours)}h seit Discovery`;
  }

  return null;
}

async function removePaperWhaleFromQuarantine(
  whales: WhaleRecord[],
  whaleAddress: string,
  summary: ReturnType<typeof getModeMetrics>,
  telegramTitle: string,
  dedupeKey: string,
  logReason: string,
) {
  const remainingWhales = whales.filter((item) => item.address !== whaleAddress);
  writeJsonFileSync(WHALE_FILE, remainingWhales);

  const paperData = readLegacyPerformance(PAPER_PERF_FILE);
  delete paperData[whaleAddress];
  writeLegacyPerformance(PAPER_PERF_FILE, paperData);

  const whaleStats = readWhaleStats();
  delete whaleStats[whaleAddress];
  writeWhaleStats(whaleStats);

  const paperTrades = readJsonFileSync<Record<string, { whale?: string }>>(PAPER_TRADES_FILE, {});
  const filteredPaperTrades = Object.fromEntries(
    Object.entries(paperTrades).filter(([, trade]) => trade?.whale !== whaleAddress),
  );
  writeJsonFileSync(PAPER_TRADES_FILE, filteredPaperTrades);

  await sendTelegram(
    `${telegramTitle}\nAdresse: <code>${whaleAddress.slice(0, 8)}...</code>\nBewertet: <b>${summary.evaluatedTrades}</b> Trades\nWin-Rate: <b>${(summary.winRatePct ?? 0).toFixed(0)}%</b>\nAvg PnL: <b>${(summary.avgPnlPct ?? 0).toFixed(1)}%</b>\nMedian PnL: <b>${(summary.medianPnlPct ?? 0).toFixed(1)}%</b>\nStatus: <b>AUS QUARANTAENE ENTFERNT</b>`,
    {
      dedupeKey,
      cooldownMs: 24 * 60 * 60 * 1000,
      priority: true,
    },
  );
  console.log(`[CLEANUP] Paper-Wal ${whaleAddress} entfernt: ${logReason}.`);
}

function shouldRejectPaperWhale(summary: ReturnType<typeof getModeMetrics>): boolean {
  if (summary.evaluatedTrades < env.PAPER_PROMOTION_MIN_TRADES) {
    return false;
  }

  const winRatePct = summary.winRatePct ?? 0;
  const avgPnlPct = summary.avgPnlPct ?? 0;
  const medianPnlPct = summary.medianPnlPct ?? 0;

  const hardReject = winRatePct <= PAPER_HARD_REJECTION_MAX_WIN_RATE_PCT
    && (avgPnlPct <= PAPER_HARD_REJECTION_MAX_AVG_PNL_PCT || medianPnlPct <= PAPER_HARD_REJECTION_MAX_MEDIAN_PNL_PCT);
  if (hardReject) {
    return true;
  }

  const earlyReject = winRatePct <= PAPER_EARLY_REJECTION_MAX_WIN_RATE_PCT
    && avgPnlPct <= PAPER_EARLY_REJECTION_MAX_AVG_PNL_PCT
    && medianPnlPct <= PAPER_EARLY_REJECTION_MAX_MEDIAN_PNL_PCT;
  if (earlyReject) {
    return true;
  }

  if (summary.evaluatedTrades < PAPER_EXTENDED_REVIEW_TRADES) {
    return false;
  }

  if (winRatePct <= PAPER_EXTENDED_REJECTION_MAX_WIN_RATE_PCT
    && avgPnlPct <= PAPER_EXTENDED_REJECTION_MAX_AVG_PNL_PCT
    && medianPnlPct <= PAPER_EXTENDED_REJECTION_MAX_MEDIAN_PNL_PCT) {
    return true;
  }

  if (summary.evaluatedTrades >= PAPER_FINAL_STAGNATION_REVIEW_TRADES) {
    return winRatePct < PAPER_FINAL_STAGNATION_MIN_WIN_RATE_PCT
      || avgPnlPct < PAPER_FINAL_STAGNATION_MIN_AVG_PNL_PCT
      || medianPnlPct < PAPER_FINAL_STAGNATION_MIN_MEDIAN_PNL_PCT;
  }

  if (summary.evaluatedTrades >= PAPER_STAGNATION_REVIEW_TRADES) {
    return winRatePct < PAPER_STAGNATION_MIN_WIN_RATE_PCT
      && (
        avgPnlPct < PAPER_STAGNATION_MIN_AVG_PNL_PCT
        || medianPnlPct < PAPER_STAGNATION_MIN_MEDIAN_PNL_PCT
      );
  }

  return false;
}

async function maybeFinalizePaperWhale(whaleAddress: string) {
  const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
  const whale = whales.find((item) => item.address === whaleAddress);
  if (!whale || whale.mode !== 'paper') {
    return;
  }

  const summary = getModeMetrics(whaleAddress, 'paper');
  const expiryReason = getPaperExpiryReason(whale, summary);
  if (expiryReason) {
    await removePaperWhaleFromQuarantine(
      whales,
      whaleAddress,
      summary,
      '⏳ <b>PAPER-WAL ABGELAUFEN</b>',
      `whale-paper-expired:${whaleAddress}`,
      expiryReason,
    );
    return;
  }

  if (summary.evaluatedTrades < env.PAPER_PROMOTION_MIN_TRADES) {
    return;
  }

  if (isPaperPromotionReady(summary)) {
    const promotedWhales = whales.map((item) => item.address === whaleAddress
      ? { ...item, mode: 'live' as const, promotedAt: new Date().toISOString() }
      : item);
    writeJsonFileSync(WHALE_FILE, promotedWhales);

    await sendTelegram(
      `🏆 <b>WAL VALIDIERT</b>\nAdresse: <code>${whaleAddress.slice(0, 8)}...</code>\nBewertet: <b>${summary.evaluatedTrades}</b> Trades\nWin-Rate: <b>${(summary.winRatePct ?? 0).toFixed(0)}%</b>\nAvg PnL: <b>${(summary.avgPnlPct ?? 0).toFixed(1)}%</b>\nMedian PnL: <b>${(summary.medianPnlPct ?? 0).toFixed(1)}%</b>\nStatus: <b>LIVE AUTO-BUY AKTIV</b>`,
      {
        dedupeKey: `whale-promoted:${whaleAddress}`,
        cooldownMs: 24 * 60 * 60 * 1000,
        priority: true,
      },
    );
    return;
  }

  if (!shouldRejectPaperWhale(summary)) {
    return;
  }

  await removePaperWhaleFromQuarantine(
    whales,
    whaleAddress,
    summary,
    '🧪 <b>WAL TEST NICHT BESTANDEN</b>',
    `whale-paper-rejected:${whaleAddress}`,
    `nach ${summary.evaluatedTrades} Trades nicht bestanden`,
  );
}

export async function reconcilePaperWhales() {
  const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
  for (const whale of whales) {
    if (whale.mode !== 'paper') {
      continue;
    }

    await maybeFinalizePaperWhale(whale.address);
  }
}

async function maybeEliminateLiveWhale(whaleAddress: string) {
  const summary = getModeMetrics(whaleAddress, 'live');
  if (summary.evaluatedTrades < env.LIVE_ELIMINATION_MIN_TRADES) {
    return;
  }

  const shouldEliminateByStreak = summary.lossStreak >= env.LIVE_ELIMINATION_MAX_LOSS_STREAK;
  const shouldEliminateByAverage = (summary.avgPnlPct ?? Number.POSITIVE_INFINITY) <= env.LIVE_ELIMINATION_MAX_AVG_PNL_PCT;

  if (!shouldEliminateByStreak && !shouldEliminateByAverage) {
    return;
  }

  const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
  const remainingWhales = whales.filter((item) => item.address !== whaleAddress);
  writeJsonFileSync(WHALE_FILE, remainingWhales);

  const liveData = readLegacyPerformance(PERF_FILE);
  delete liveData[whaleAddress];
  writeLegacyPerformance(PERF_FILE, liveData);

  await sendTelegram(
    `🚫 <b>WAL ELIMINIERT</b>\nAdresse: <code>${whaleAddress.slice(0, 8)}...</code>\nBewertet: <b>${summary.evaluatedTrades}</b> Trades\nLoss-Streak: <b>${summary.lossStreak}</b>\nAvg PnL: <b>${(summary.avgPnlPct ?? 0).toFixed(1)}%</b>`,
    {
      dedupeKey: `whale-eliminated:${whaleAddress}`,
      cooldownMs: 6 * 60 * 60 * 1000,
      priority: true,
    },
  );
  console.log(`[CLEANUP] Wal ${whaleAddress} entfernt.`);
}

async function logModePerformance(mode: WhaleTradeMode, legacyFile: string, whaleAddress: string, input: boolean | WhalePerformanceInput) {
  const metric = normalizePerformanceInput(input);
  if (metric.discardReason) {
    appendWhaleTradeDiscard(whaleAddress, mode, {
      reason: metric.discardReason,
      ...(metric.mint ? { mint: metric.mint } : {}),
    });
    syncWhaleTradeCounts(whaleAddress);
    return;
  }

  appendWhaleTradeMetric(whaleAddress, mode, metric);
  syncLegacyOutcome(legacyFile, whaleAddress, metric.pnlPct > 0);
  syncWhaleTradeCounts(whaleAddress);

  if (mode === 'paper') {
    await maybeFinalizePaperWhale(whaleAddress);
    return;
  }

  await maybeEliminateLiveWhale(whaleAddress);
}

export async function logWhalePerformance(whaleAddress: string, input: boolean | WhalePerformanceInput) {
  try {
    await logModePerformance('live', PERF_FILE, whaleAddress, input);
  } catch (error) {
    console.error('Performance Tracker Error:', error);
  }
}

export async function logPaperWhalePerformance(whaleAddress: string, input: boolean | WhalePerformanceInput) {
  try {
    await logModePerformance('paper', PAPER_PERF_FILE, whaleAddress, input);
  } catch (error) {
    console.error('Paper Performance Tracker Error:', error);
  }
}

export function discardPaperWhalePerformance(whaleAddress: string, reason: string, mint?: string) {
  try {
    appendWhaleTradeDiscard(whaleAddress, 'paper', {
      reason,
      ...(mint ? { mint } : {}),
    });
    syncWhaleTradeCounts(whaleAddress);
  } catch (error) {
    console.error('Paper Performance Discard Error:', error);
  }
}
