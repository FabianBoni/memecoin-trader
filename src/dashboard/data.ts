import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { env, getHeliusRpcUrl, getReadOnlyRpcUrl } from "../config/env.js";
import { clearDecisionLog, readDecisionLog, type DecisionLogEntry } from "../storage/decision-log.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { resolveSrcDataPath } from "../utils/repo-paths.js";
import {
  buildWhaleModeSummary,
  clearWhaleStats,
  readWhaleStats,
  resetWhaleModeStats,
  type WhaleModeSummary,
  type WhaleStatsStore,
} from "../storage/whale-stats.js";
import { clearWhales, patchWhale, readWhales, writeWhales, type WhaleRecord } from "../storage/whales.js";
import { readRuntimeStatus, type RuntimeStatusStore } from "../storage/runtime-status.js";

const DATA_DIR = resolveSrcDataPath();
const PAPER_PERFORMANCE_FILE = path.join(DATA_DIR, "paper-performance.json");
const PAPER_TRADES_FILE = path.join(DATA_DIR, "paper-trades.json");
const ACTIVE_TRADES_FILE = path.join(DATA_DIR, "active-trades.json");
const TRADE_HISTORY_FILE = path.join(DATA_DIR, "trade-history.json");
const WHALE_ACTIVITY_FILE = path.join(DATA_DIR, "whale-activity.json");

const WHALE_DETAIL_CACHE_MS = 60 * 1000;
const WHALE_DETAIL_PAGE_LIMIT = 3;
const WHALE_DETAIL_SIGNATURES_PER_PAGE = 15;
const WHALE_DETAIL_PARSE_BATCH_SIZE = 5;

let dashboardConnection: Connection | null = null;
const whaleTransactionCache = new Map<string, { fetchedAt: number; data: WhaleTransactionSummary[] }>();

type UnknownRecord = Record<string, unknown>;
type TradeStore = Record<string, UnknownRecord>;

export type WhaleTokenDelta = {
  mint: string;
  delta: number;
};

export type WhaleTransactionSummary = {
  signature: string;
  detectedAt: string;
  success: boolean;
  feeSol: number;
  solDelta: number | null;
  tokenDeltas: WhaleTokenDelta[];
};

export type DashboardMetricTotals = {
  whales: number;
  liveWhales: number;
  paperWhales: number;
  openLiveTrades: number;
  openPaperTrades: number;
  runnerCount: number;
  partialOpenCount: number;
  trimPendingCount: number;
  totalLiveEvaluatedTrades: number;
  totalPaperEvaluatedTrades: number;
  totalPaperDiscards: number;
  finalizedExitCount: number;
  partialExitCount: number;
  averageRealizedPnlPct: number | null;
  globalWinRatePct: number | null;
};

export type DashboardThresholds = {
  paperPromotionMinTrades: number;
  paperPromotionMinWinRatePct: number;
  paperPromotionMinAvgPnlPct: number;
  paperPromotionMinMedianPnlPct: number;
  minEntryLiquidityUsd: number;
  minWhaleBuySizeSol: number;
  trackerSignalMinBuyUsd: number;
};

export type DashboardLiveTrade = {
  mint: string;
  whale: string;
  openedAt: string | null;
  entryPrice: number | null;
  entryPriceSource: string | null;
  positionSol: number | null;
  remainingFraction: number;
  realizedSoldFraction: number;
  realizedPnlPct: number | null;
  pendingTrimFraction: number;
  lastActionReason: string | null;
  lastActionAt: string | null;
  panic: boolean;
  recoveredFromWallet: boolean;
  takeProfitTaken: boolean;
};

export type DashboardPaperTrade = {
  tradeId: string;
  mint: string;
  whale: string;
  openedAt: string | null;
  entryPrice: number | null;
  entryPriceSol: number | null;
  entryPriceSource: string | null;
  remainingFraction: number;
  realizedPnlPct: number | null;
  lastActionReason: string | null;
  lastActionAt: string | null;
  whaleSoldFraction: number;
  panic: boolean;
  takeProfitTaken: boolean;
  evaluatedTrades: number;
  noPriceDiscards: number;
};

export type DashboardLeaderboardRow = {
  address: string;
  mode: WhaleRecord["mode"] | "untracked";
  wins: number;
  losses: number;
  total: number;
  streak: string;
  winRatePct: number | null;
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  panicExitRatePct: number | null;
};

export type DashboardPaperWhale = WhaleRecord & {
  wins: number;
  losses: number;
  total: number;
  streak: string;
  winRatePct: number | null;
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  noPriceDiscards: number;
  readyForPromotion: boolean;
};

export type DashboardWhaleActivity = {
  whale: string;
  mint: string;
  side: string;
  detectedAt: string | null;
  signature: string | null;
  botMode: string | null;
};

export type DashboardExitRow = {
  mint: string;
  date: string | null;
  reason: string | null;
  partial: boolean;
  soldFractionPct: number | null;
  remainingFractionPct: number | null;
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  entryPriceSol: number | null;
  exitPriceSol: number | null;
  priceSource: string | null;
  pnlPct: number | null;
  combinedPnlPct: number | null;
};

export type DashboardDiagnostic = {
  key: string;
  title: string;
  tone: "good" | "warn" | "bad" | "neutral";
  detectedAt: string | null;
  detail: string;
};

export type DashboardSnapshot = {
  generatedAt: string;
  thresholds: DashboardThresholds;
  totals: DashboardMetricTotals;
  runtimeStatus: RuntimeStatusStore;
  diagnostics: DashboardDiagnostic[];
  decisionEvents: DecisionLogEntry[];
  liveTrades: DashboardLiveTrade[];
  paperTrades: DashboardPaperTrade[];
  leaderboard: DashboardLeaderboardRow[];
  paperWhales: DashboardPaperWhale[];
  whaleActivity: DashboardWhaleActivity[];
  recentExits: DashboardExitRow[];
};

export type WhaleDetailSnapshot = {
  whale: WhaleRecord | null;
  liveSummary: WhaleModeSummary;
  paperSummary: WhaleModeSummary;
  activity: DashboardWhaleActivity[];
  decisionEvents: DecisionLogEntry[];
  transactions: WhaleTransactionSummary[];
};

function getDashboardConnection(): Connection {
  if (!dashboardConnection) {
    dashboardConnection = new Connection(getReadOnlyRpcUrl(getHeliusRpcUrl()), {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
  }

  return dashboardConnection;
}

function safeReadDataFile<T>(filePath: string, fallback: T): T {
  try {
    return readJsonFileSync(filePath, fallback);
  } catch {
    return fallback;
  }
}

function writeDataFile<T>(filePath: string, value: T): void {
  writeJsonFileSync(filePath, value);
}

function createEmptySummary(): WhaleModeSummary {
  return {
    evaluatedTrades: 0,
    wins: 0,
    losses: 0,
    winRatePct: null,
    avgPnlPct: null,
    medianPnlPct: null,
    panicExitRatePct: null,
    avgHoldMinutes: null,
    positiveExcursionRatePct: null,
    avgRoundTripCostBps: null,
    noPriceDiscards: 0,
    streak: "",
  };
}

function getWhaleSummaries(store: WhaleStatsStore, address: string): { live: WhaleModeSummary; paper: WhaleModeSummary } {
  return {
    live: buildWhaleModeSummary(store, address, "live"),
    paper: buildWhaleModeSummary(store, address, "paper"),
  };
}

function isPromotionReady(summary: WhaleModeSummary): boolean {
  return summary.evaluatedTrades >= env.PAPER_PROMOTION_MIN_TRADES
    && (summary.winRatePct ?? 0) >= env.PAPER_PROMOTION_MIN_WIN_RATE_PCT
    && (summary.avgPnlPct ?? Number.NEGATIVE_INFINITY) >= env.PAPER_PROMOTION_MIN_AVG_PNL_PCT
    && (summary.medianPnlPct ?? Number.NEGATIVE_INFINITY) >= env.PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT;
}

function clampFraction(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

function getRealizedSoldFraction(trade: unknown): number {
  if (!trade || typeof trade !== "object") {
    return 0;
  }

  const candidate = trade as UnknownRecord;
  if (Number.isFinite(Number(candidate.realizedSoldFraction))) {
    return clampFraction(candidate.realizedSoldFraction);
  }

  if (Number.isFinite(Number(candidate.remainingPositionFraction))) {
    return clampFraction(1 - Number(candidate.remainingPositionFraction));
  }

  return 0;
}

function getRemainingPositionFraction(trade: unknown): number {
  if (!trade || typeof trade !== "object") {
    return 1;
  }

  const candidate = trade as UnknownRecord;
  if (Number.isFinite(Number(candidate.remainingPositionFraction))) {
    return clampFraction(candidate.remainingPositionFraction, 1);
  }

  return clampFraction(1 - getRealizedSoldFraction(trade), 1);
}

function getPendingWhaleTrimFraction(trade: unknown): number {
  if (!trade || typeof trade !== "object") {
    return 0;
  }

  const candidate = trade as UnknownRecord;
  const targetTrimFraction = clampFraction(
    Number.isFinite(Number(candidate.whaleTrimFraction)) ? candidate.whaleTrimFraction : candidate.whaleSoldFraction,
    0,
  );
  return Math.max(0, targetTrimFraction - getRealizedSoldFraction(trade));
}

function getRealizedPnlPctValue(trade: unknown): number | null {
  if (!trade || typeof trade !== "object") {
    return null;
  }

  const parsed = Number((trade as UnknownRecord).realizedPnlPct);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasTakeProfitTakenFlag(trade: unknown): boolean {
  return !!trade && typeof trade === "object" && (trade as UnknownRecord).takeProfitTaken === true;
}

function parseMaybeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMaybeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getTokenBalanceMap(entries: unknown, owner: string): Map<string, number> {
  const balances = new Map<string, number>();
  if (!Array.isArray(entries)) {
    return balances;
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as UnknownRecord;
    if (candidate.owner !== owner || typeof candidate.mint !== "string") {
      continue;
    }

    const amount = Number((candidate.uiTokenAmount as UnknownRecord | undefined)?.uiAmount ?? 0);
    balances.set(candidate.mint, (balances.get(candidate.mint) ?? 0) + (Number.isFinite(amount) ? amount : 0));
  }

  return balances;
}

function summarizeWhaleTransaction(parsedTx: unknown, whaleAddress: string, signature: string, blockTime: number | null | undefined): WhaleTransactionSummary {
  const txRecord = parsedTx as UnknownRecord;
  const meta = (txRecord.meta as UnknownRecord | undefined) ?? {};
  const preTokenBalances = getTokenBalanceMap(meta.preTokenBalances, whaleAddress);
  const postTokenBalances = getTokenBalanceMap(meta.postTokenBalances, whaleAddress);
  const mints = new Set<string>([...preTokenBalances.keys(), ...postTokenBalances.keys()]);
  const tokenDeltas = Array.from(mints)
    .map((mint) => ({
      mint,
      delta: (postTokenBalances.get(mint) ?? 0) - (preTokenBalances.get(mint) ?? 0),
    }))
    .filter((entry) => Math.abs(entry.delta) > 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

  const message = ((txRecord.transaction as UnknownRecord | undefined)?.message as UnknownRecord | undefined) ?? {};
  const accountKeys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const walletIndex = accountKeys.findIndex((accountKey) => {
    if (typeof accountKey === "string") {
      return accountKey === whaleAddress;
    }

    if (!accountKey || typeof accountKey !== "object") {
      return false;
    }

    const candidate = accountKey as UnknownRecord;
    if (typeof candidate.pubkey === "string") {
      return candidate.pubkey === whaleAddress;
    }

    if (candidate.pubkey && typeof candidate.pubkey === "object" && typeof (candidate.pubkey as { toBase58?: () => string }).toBase58 === "function") {
      return (candidate.pubkey as { toBase58: () => string }).toBase58() === whaleAddress;
    }

    return false;
  });

  const preBalances = Array.isArray(meta.preBalances) ? meta.preBalances : [];
  const postBalances = Array.isArray(meta.postBalances) ? meta.postBalances : [];
  const preBalance = walletIndex >= 0 ? Number(preBalances[walletIndex]) : NaN;
  const postBalance = walletIndex >= 0 ? Number(postBalances[walletIndex]) : NaN;
  const solDelta = Number.isFinite(preBalance) && Number.isFinite(postBalance)
    ? (postBalance - preBalance) / 1_000_000_000
    : null;

  return {
    signature,
    detectedAt: blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString(),
    success: !meta.err,
    feeSol: Number(meta.fee ?? 0) / 1_000_000_000,
    solDelta,
    tokenDeltas,
  };
}

function readWhaleActivity(limit?: number): DashboardWhaleActivity[] {
  const activity = safeReadDataFile<unknown[]>(WHALE_ACTIVITY_FILE, []);
  const rows = activity.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as UnknownRecord;
    const whale = parseMaybeString(candidate.whale);
    const mint = parseMaybeString(candidate.mint);
    const side = parseMaybeString(candidate.side);
    if (!whale || !mint || !side) {
      return [];
    }

    return [{
      whale,
      mint,
      side,
      detectedAt: parseMaybeString(candidate.detectedAt),
      signature: parseMaybeString(candidate.signature),
      botMode: parseMaybeString(candidate.botMode),
    } satisfies DashboardWhaleActivity];
  });

  return typeof limit === "number" ? rows.slice(0, limit) : rows;
}

function buildDiagnostics(runtimeStatus: RuntimeStatusStore): DashboardDiagnostic[] {
  const scoutStatus = (runtimeStatus.scout ?? {}) as UnknownRecord;
  const trackerStatus = (runtimeStatus.tracker ?? {}) as UnknownRecord;
  const positionManagerStatus = (runtimeStatus.positionManager ?? {}) as UnknownRecord;

  const diagnostics: DashboardDiagnostic[] = [
    {
      key: "scout",
      title: "Scout cycle",
      tone: scoutStatus.state === "error" ? "bad" : scoutStatus.state === "idle" ? "good" : "neutral",
      detectedAt: parseMaybeString(scoutStatus.lastRunAt) ?? parseMaybeString(scoutStatus.lastSuccessAt) ?? parseMaybeString(scoutStatus.lastErrorAt),
      detail: scoutStatus.state === "error"
        ? `Scout error: ${String(scoutStatus.lastError ?? "unbekannt")}`
        : `Eligible seeds ${Number(scoutStatus.eligibleSeedCount ?? 0)} · high-volume ${Number(scoutStatus.highVolumeSeedCount ?? 0)} · last token ${String(scoutStatus.lastToken ?? "n/a")}`,
    },
    {
      key: "tracker-signal",
      title: "Last tracker signal",
      tone: parseMaybeString(trackerStatus.lastSignalAt) ? "good" : "neutral",
      detectedAt: parseMaybeString(trackerStatus.lastSignalAt),
      detail: `${String(trackerStatus.lastSignalSide ?? "n/a")} ${String(trackerStatus.lastSignalMint ?? "n/a")} · subscriptions ${Number(trackerStatus.activeSubscriptions ?? 0)}`,
    },
    {
      key: "tracker-ignored-cluster",
      title: "Cluster floor block",
      tone: parseMaybeString(trackerStatus.lastIgnoredClusterSignalAt) ? "warn" : "neutral",
      detectedAt: parseMaybeString(trackerStatus.lastIgnoredClusterSignalAt),
      detail: parseMaybeString(trackerStatus.lastIgnoredClusterSignalAt)
        ? `${String(trackerStatus.lastIgnoredClusterSignalMint ?? "n/a")} by ${String(trackerStatus.lastIgnoredClusterSignalWhale ?? "n/a")} · buy ${String(trackerStatus.lastIgnoredClusterSignalBuyUsd ?? "n/a")} vs floor ${String(trackerStatus.lastIgnoredClusterSignalMinBuyUsd ?? "n/a")}`
        : "Kein aktueller Cluster-Floor-Block gespeichert.",
    },
    {
      key: "tracker-paper-bypass",
      title: "Paper bypass",
      tone: parseMaybeString(trackerStatus.lastPaperBypassAt) ? "good" : "neutral",
      detectedAt: parseMaybeString(trackerStatus.lastPaperBypassAt),
      detail: parseMaybeString(trackerStatus.lastPaperBypassAt)
        ? `${String(trackerStatus.lastPaperBypassMint ?? "n/a")} by ${String(trackerStatus.lastPaperBypassWhale ?? "n/a")} · ${String(trackerStatus.lastPaperBypassReason ?? "bypass")}`
        : "Noch kein Paper-Bypass registriert.",
    },
    {
      key: "tracker-paper-block",
      title: "Paper signal block",
      tone: parseMaybeString(trackerStatus.lastBlockedPaperSignalAt) ? "warn" : "neutral",
      detectedAt: parseMaybeString(trackerStatus.lastBlockedPaperSignalAt),
      detail: parseMaybeString(trackerStatus.lastBlockedPaperSignalAt)
        ? `${String(trackerStatus.lastBlockedPaperMint ?? "n/a")} by ${String(trackerStatus.lastBlockedPaperWhale ?? "n/a")} · ${String(trackerStatus.lastBlockedPaperReason ?? "blockiert")}`
        : "Kein aktueller Paper-Block gespeichert.",
    },
    {
      key: "tracker-cluster-reject",
      title: "Entry reject",
      tone: parseMaybeString(trackerStatus.lastRejectedClusterAt) ? "bad" : "neutral",
      detectedAt: parseMaybeString(trackerStatus.lastRejectedClusterAt),
      detail: parseMaybeString(trackerStatus.lastRejectedClusterAt)
        ? `${String(trackerStatus.lastRejectedClusterMint ?? "n/a")} · ${String(trackerStatus.lastRejectedClusterReason ?? "rejected")}`
        : "Kein aktueller Entry-Reject gespeichert.",
    },
    {
      key: "tracker-live-block",
      title: "Live execution block",
      tone: parseMaybeString(trackerStatus.lastBlockedLiveSignalAt) ? "warn" : "neutral",
      detectedAt: parseMaybeString(trackerStatus.lastBlockedLiveSignalAt),
      detail: parseMaybeString(trackerStatus.lastBlockedLiveSignalAt)
        ? `${String(trackerStatus.lastBlockedLiveMint ?? "n/a")} by ${String(trackerStatus.lastBlockedLiveWhale ?? "n/a")} · ${String(trackerStatus.lastBlockedLiveReason ?? "blockiert")}`
        : "Kein aktueller Live-Block gespeichert.",
    },
    {
      key: "monitor",
      title: "Position monitor",
      tone: positionManagerStatus.state === "error" ? "bad" : positionManagerStatus.state === "monitoring" ? "good" : "neutral",
      detectedAt: parseMaybeString(positionManagerStatus.lastRunAt) ?? parseMaybeString(positionManagerStatus.lastErrorAt),
      detail: positionManagerStatus.state === "error"
        ? `Monitor error: ${String(positionManagerStatus.lastError ?? "unbekannt")}`
        : `Open paper ${Number(positionManagerStatus.openPaperTrades ?? 0)} · open live ${Number(positionManagerStatus.openLiveTrades ?? 0)} · cache ${Number(positionManagerStatus.priceCacheEntries ?? 0)}`,
    },
  ];

  return diagnostics.sort((left, right) => {
    const leftTime = left.detectedAt ? Date.parse(left.detectedAt) : 0;
    const rightTime = right.detectedAt ? Date.parse(right.detectedAt) : 0;
    return rightTime - leftTime;
  });
}

export function resetPaperWhale(address: string): void {
  patchWhale(address, { paperTrades: 0 });

  const paperPerformance = safeReadDataFile<Record<string, boolean[]>>(PAPER_PERFORMANCE_FILE, {});
  delete paperPerformance[address];

  const paperTrades = safeReadDataFile<Record<string, UnknownRecord>>(PAPER_TRADES_FILE, {});
  const filteredPaperTrades = Object.fromEntries(
    Object.entries(paperTrades).filter(([, trade]) => trade?.whale !== address),
  );

  writeDataFile(PAPER_PERFORMANCE_FILE, paperPerformance);
  writeDataFile(PAPER_TRADES_FILE, filteredPaperTrades);
  resetWhaleModeStats("paper", address);
}

export function resetAllPaperWhales(): void {
  const whales = readWhales();
  const updatedWhales = whales.map((whale) => whale.mode === "paper" ? { ...whale, paperTrades: 0 } : whale);
  writeWhales(updatedWhales);
  writeDataFile(PAPER_PERFORMANCE_FILE, {});
  writeDataFile(PAPER_TRADES_FILE, {});
  resetWhaleModeStats("paper");
}

export function resetAllWhales(): void {
  clearWhales();
  clearWhaleStats();
  clearDecisionLog();
  writeDataFile(path.join(DATA_DIR, "performance.json"), {});
  writeDataFile(PAPER_PERFORMANCE_FILE, {});
  writeDataFile(PAPER_TRADES_FILE, {});
  writeDataFile(WHALE_ACTIVITY_FILE, []);
  whaleTransactionCache.clear();
}

export function getDashboardSnapshot(): DashboardSnapshot {
  const whales = readWhales();
  const activeTrades = safeReadDataFile<TradeStore>(ACTIVE_TRADES_FILE, {});
  const paperTrades = safeReadDataFile<TradeStore>(PAPER_TRADES_FILE, {});
  const whaleStatsStore = readWhaleStats();
  const whaleActivity = readWhaleActivity(20);
  const decisionEvents = readDecisionLog(40);
  const runtimeStatus = readRuntimeStatus();
  const history = safeReadDataFile<unknown[]>(TRADE_HISTORY_FILE, []);
  const paperWhaleCount = whales.filter((whale) => whale.mode === "paper").length;
  const knownWhaleAddresses = Array.from(new Set([...whales.map((whale) => whale.address), ...Object.keys(whaleStatsStore)]));
  const summaryByAddress = new Map(knownWhaleAddresses.map((address) => [address, getWhaleSummaries(whaleStatsStore, address)]));

  const leaderboard = knownWhaleAddresses
    .map((address) => {
      const whale = whales.find((entry) => entry.address === address);
      const liveSummary = summaryByAddress.get(address)?.live ?? createEmptySummary();
      return {
        address,
        mode: whale?.mode ?? "untracked",
        wins: liveSummary.wins,
        losses: liveSummary.losses,
        total: liveSummary.evaluatedTrades,
        streak: liveSummary.streak,
        winRatePct: liveSummary.winRatePct,
        avgPnlPct: liveSummary.avgPnlPct,
        medianPnlPct: liveSummary.medianPnlPct,
        panicExitRatePct: liveSummary.panicExitRatePct,
      } satisfies DashboardLeaderboardRow;
    })
    .filter((entry) => entry.total > 0)
    .sort((left, right) => {
      const avgDiff = (right.avgPnlPct ?? Number.NEGATIVE_INFINITY) - (left.avgPnlPct ?? Number.NEGATIVE_INFINITY);
      if (avgDiff !== 0) {
        return avgDiff;
      }

      return (right.winRatePct ?? -1) - (left.winRatePct ?? -1);
    });

  const totalWins = leaderboard.reduce((sum, stat) => sum + stat.wins, 0);
  const totalTrades = leaderboard.reduce((sum, stat) => sum + stat.total, 0);
  const totalPaperEvaluatedTrades = whales.reduce((sum, whale) => sum + (summaryByAddress.get(whale.address)?.paper.evaluatedTrades ?? 0), 0);
  const totalPaperDiscards = whales.reduce((sum, whale) => sum + (summaryByAddress.get(whale.address)?.paper.noPriceDiscards ?? 0), 0);

  const paperWhales = whales
    .filter((whale) => whale.mode === "paper")
    .map((whale) => {
      const paperSummary = summaryByAddress.get(whale.address)?.paper ?? createEmptySummary();
      return {
        ...whale,
        wins: paperSummary.wins,
        losses: paperSummary.losses,
        total: paperSummary.evaluatedTrades,
        streak: paperSummary.streak,
        winRatePct: paperSummary.winRatePct,
        avgPnlPct: paperSummary.avgPnlPct,
        medianPnlPct: paperSummary.medianPnlPct,
        noPriceDiscards: paperSummary.noPriceDiscards,
        readyForPromotion: isPromotionReady(paperSummary),
      } satisfies DashboardPaperWhale;
    })
    .sort((left, right) => {
      const readyDiff = Number(right.readyForPromotion) - Number(left.readyForPromotion);
      if (readyDiff !== 0) {
        return readyDiff;
      }

      if (right.total !== left.total) {
        return right.total - left.total;
      }

      return Date.parse(right.discoveredAt ?? "") - Date.parse(left.discoveredAt ?? "");
    });

  const liveTrades = Object.entries(activeTrades).flatMap(([mint, trade]) => {
    const whale = parseMaybeString(trade.whale);
    if (!whale) {
      return [];
    }

    return [{
      mint,
      whale,
      openedAt: parseMaybeString(trade.openedAt),
      entryPrice: parseMaybeNumber(trade.entryPrice),
      entryPriceSource: parseMaybeString(trade.entryPriceSource),
      positionSol: parseMaybeNumber(trade.positionSol),
      remainingFraction: getRemainingPositionFraction(trade),
      realizedSoldFraction: getRealizedSoldFraction(trade),
      realizedPnlPct: getRealizedPnlPctValue(trade),
      pendingTrimFraction: getPendingWhaleTrimFraction(trade),
      lastActionReason: parseMaybeString(trade.lastPartialExitReason),
      lastActionAt: parseMaybeString(trade.lastPartialExitAt) ?? parseMaybeString(trade.openedAt),
      panic: trade.panic === true,
      recoveredFromWallet: trade.recoveredFromWallet === true,
      takeProfitTaken: hasTakeProfitTakenFlag(trade),
    } satisfies DashboardLiveTrade];
  });

  const paperTradeRows = Object.entries(paperTrades).flatMap(([tradeId, trade]) => {
    const whale = parseMaybeString(trade.whale);
    const mint = parseMaybeString(trade.mint);
    if (!whale || !mint) {
      return [];
    }

    const paperSummary = summaryByAddress.get(whale)?.paper ?? createEmptySummary();
    return [{
      tradeId,
      mint,
      whale,
      openedAt: parseMaybeString(trade.openedAt),
      entryPrice: parseMaybeNumber(trade.entryPrice),
      entryPriceSol: parseMaybeNumber(trade.entryPriceSol),
      entryPriceSource: parseMaybeString(trade.entryPriceSource),
      remainingFraction: getRemainingPositionFraction(trade),
      realizedPnlPct: getRealizedPnlPctValue(trade),
      lastActionReason: parseMaybeString(trade.lastPartialExitReason),
      lastActionAt: parseMaybeString(trade.lastPartialExitAt) ?? parseMaybeString(trade.openedAt),
      whaleSoldFraction: clampFraction(trade.whaleSoldFraction, 0),
      panic: trade.panic === true,
      takeProfitTaken: hasTakeProfitTakenFlag(trade),
      evaluatedTrades: paperSummary.evaluatedTrades,
      noPriceDiscards: paperSummary.noPriceDiscards,
    } satisfies DashboardPaperTrade];
  });

  const historyRows = Array.isArray(history) ? history : [];
  const finalizedHistoryRows = historyRows.filter((trade) => trade && typeof trade === "object" && (trade as UnknownRecord).partial !== true);
  const partialExitCount = historyRows.filter((trade) => trade && typeof trade === "object" && (trade as UnknownRecord).partial === true).length;
  const realizedPnlValues = finalizedHistoryRows
    .map((trade) => parseMaybeNumber((trade as UnknownRecord).combinedPnlPct ?? (trade as UnknownRecord).pnl))
    .filter((value): value is number => value !== null);
  const averageRealizedPnlPct = realizedPnlValues.length > 0
    ? realizedPnlValues.reduce((sum, value) => sum + value, 0) / realizedPnlValues.length
    : null;

  const recentExits = historyRows.flatMap((trade) => {
    if (!trade || typeof trade !== "object") {
      return [];
    }

    const candidate = trade as UnknownRecord;
    const mint = parseMaybeString(candidate.mint);
    if (!mint) {
      return [];
    }

    return [{
      mint,
      date: parseMaybeString(candidate.date),
      reason: parseMaybeString(candidate.reason),
      partial: candidate.partial === true,
      soldFractionPct: parseMaybeNumber(candidate.soldFractionPct),
      remainingFractionPct: parseMaybeNumber(candidate.remainingFractionPct),
      entryPriceUsd: parseMaybeNumber(candidate.entryPriceUsd),
      exitPriceUsd: parseMaybeNumber(candidate.exitPriceUsd),
      entryPriceSol: parseMaybeNumber(candidate.entryPriceSol),
      exitPriceSol: parseMaybeNumber(candidate.exitPriceSol),
      priceSource: parseMaybeString(candidate.priceSource),
      pnlPct: parseMaybeNumber(candidate.pnl),
      combinedPnlPct: parseMaybeNumber(candidate.combinedPnlPct),
    } satisfies DashboardExitRow];
  });

  const totals: DashboardMetricTotals = {
    whales: whales.length,
    liveWhales: whales.length - paperWhaleCount,
    paperWhales: paperWhaleCount,
    openLiveTrades: liveTrades.length,
    openPaperTrades: paperTradeRows.length,
    runnerCount: liveTrades.filter((trade) => trade.takeProfitTaken).length,
    partialOpenCount: liveTrades.filter((trade) => trade.realizedSoldFraction > 0).length,
    trimPendingCount: liveTrades.filter((trade) => trade.pendingTrimFraction > 0).length,
    totalLiveEvaluatedTrades: totalTrades,
    totalPaperEvaluatedTrades,
    totalPaperDiscards,
    finalizedExitCount: finalizedHistoryRows.length,
    partialExitCount,
    averageRealizedPnlPct,
    globalWinRatePct: totalTrades > 0 ? (totalWins / totalTrades) * 100 : null,
  };

  return {
    generatedAt: new Date().toISOString(),
    thresholds: {
      paperPromotionMinTrades: env.PAPER_PROMOTION_MIN_TRADES,
      paperPromotionMinWinRatePct: env.PAPER_PROMOTION_MIN_WIN_RATE_PCT,
      paperPromotionMinAvgPnlPct: env.PAPER_PROMOTION_MIN_AVG_PNL_PCT,
      paperPromotionMinMedianPnlPct: env.PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT,
      minEntryLiquidityUsd: env.MIN_ENTRY_LIQUIDITY_USD,
      minWhaleBuySizeSol: env.MIN_WHALE_BUY_SIZE_SOL,
      trackerSignalMinBuyUsd: env.TRACKER_SIGNAL_MIN_BUY_USD,
    },
    totals,
    runtimeStatus,
    diagnostics: buildDiagnostics(runtimeStatus),
    decisionEvents,
    liveTrades,
    paperTrades: paperTradeRows,
    leaderboard,
    paperWhales,
    whaleActivity,
    recentExits,
  };
}

export async function getWhaleDetailSnapshot(address: string): Promise<WhaleDetailSnapshot | null> {
  const whaleAddress = address.trim();
  if (!whaleAddress) {
    return null;
  }

  const whales = readWhales();
  const whale = whales.find((entry) => entry.address === whaleAddress) ?? null;
  const whaleStatsStore = readWhaleStats();
  const liveSummary = getWhaleSummaries(whaleStatsStore, whaleAddress).live;
  const paperSummary = getWhaleSummaries(whaleStatsStore, whaleAddress).paper;
  const activity = readWhaleActivity().filter((entry) => entry.whale === whaleAddress).slice(0, 20);
  const decisionEvents = readDecisionLog().filter((entry) => entry.whale === whaleAddress).slice(0, 25);
  const transactions = await fetchRecentWhaleTransactions(whaleAddress);

  return {
    whale,
    liveSummary,
    paperSummary,
    activity,
    decisionEvents,
    transactions,
  };
}

export async function fetchRecentWhaleTransactions(whaleAddress: string): Promise<WhaleTransactionSummary[]> {
  const cached = whaleTransactionCache.get(whaleAddress);
  if (cached && (Date.now() - cached.fetchedAt) < WHALE_DETAIL_CACHE_MS) {
    return cached.data;
  }

  const connection = getDashboardConnection();
  const whalePubkey = new PublicKey(whaleAddress);
  const cutoffUnix = Math.floor((Date.now() - (12 * 60 * 60 * 1000)) / 1000);
  const signatures: Array<{ signature: string; blockTime: number | null }> = [];
  let before: string | undefined;

  for (let page = 0; page < WHALE_DETAIL_PAGE_LIMIT; page += 1) {
    const batch = await connection.getSignaturesForAddress(whalePubkey, {
      limit: WHALE_DETAIL_SIGNATURES_PER_PAGE,
      ...(before ? { before } : {}),
    });

    if (batch.length === 0) {
      break;
    }

    let reachedOlderEntries = false;
    for (const entry of batch) {
      if (entry.blockTime && entry.blockTime < cutoffUnix) {
        reachedOlderEntries = true;
        break;
      }

      signatures.push({ signature: entry.signature, blockTime: entry.blockTime ?? null });
    }

    if (reachedOlderEntries) {
      break;
    }

    before = batch[batch.length - 1]?.signature;
  }

  const parsedTransactions: WhaleTransactionSummary[] = [];
  for (let index = 0; index < signatures.length; index += WHALE_DETAIL_PARSE_BATCH_SIZE) {
    const chunk = signatures.slice(index, index + WHALE_DETAIL_PARSE_BATCH_SIZE);
    const chunkResults = await Promise.all(
      chunk.map((entry) => connection.getParsedTransaction(entry.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      }).then((parsedTx) => parsedTx ? summarizeWhaleTransaction(parsedTx, whaleAddress, entry.signature, entry.blockTime) : null)),
    );

    parsedTransactions.push(...chunkResults.filter((entry): entry is WhaleTransactionSummary => entry !== null));
  }

  whaleTransactionCache.set(whaleAddress, { fetchedAt: Date.now(), data: parsedTransactions });
  return parsedTransactions;
}