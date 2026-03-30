import { Connection, PublicKey } from "@solana/web3.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DexscreenerClient } from '../clients/dexscreener.js';
import { env, getHeliusRpcUrl, getReadOnlyRpcUrl } from "../config/env.js";
import { riskConfig } from '../config/risk.js';
import { TokenScreenService } from '../services/token-screen.js';
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { getWhaleModeSummary, type WhaleModeSummary } from '../storage/whale-stats.js';
import { updateRuntimeStatus } from '../storage/runtime-status.js';
import { loadExecutionWallet } from "../wallet.js";
import { normalizeWhales, type WhaleRecord } from '../storage/whales.js';
import { createAsyncLimiter, isSolanaRpcRateLimitError, withRpcRetry } from '../solana/rpc-guard.js';
import type { DexPairSummary } from '../types/market.js';
import type { TokenSecurityScreen } from '../types/token.js';
import type { ExecutionMode, TradePlan } from '../types/trade.js';
import { chooseHotExecutionMode } from '../services/execution-routing.js';
import { sendTelegram } from "./telegram-notifier.js";

const PRIMARY_RPC_URL = getHeliusRpcUrl();
const READ_RPC_URL = getReadOnlyRpcUrl(PRIMARY_RPC_URL);
const WS_URL = PRIMARY_RPC_URL.replace("https://", "wss://");
const connection = new Connection(PRIMARY_RPC_URL, {
  wsEndpoint: WS_URL,
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
});
const readConnection = new Connection(READ_RPC_URL, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
});
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/active-trades.json');
const PAPER_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/paper-trades.json');
const WHALES_PATH = path.resolve(SCRIPT_DIR, '../data/whales.json');
const WHALE_ACTIVITY_PATH = path.resolve(SCRIPT_DIR, '../data/whale-activity.json');
const WHALE_SUBSCRIPTION_REFRESH_MS = 60 * 1000;
const WHALE_SIGNAL_COOLDOWN_MS = 90 * 1000;
const TRACKER_PRICE_CACHE_TTL_MS = 15_000;
const TRACKER_PRICE_CONCURRENCY = 3;
const TRACKER_RPC_CONCURRENCY = 2;
const TRACKER_RPC_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const MIN_SOL_RESERVE = Number(process.env.MIN_SOL_RESERVE || '0.05');
const MIN_RELIABLE_WHALE_SOL_DELTA = 0.01;
const PAPER_SIGNAL_BLOCK_MIN_TRADES = Math.max(env.PAPER_PROMOTION_MIN_TRADES, 8);
const PAPER_SIGNAL_BLOCK_EXTENDED_TRADES = Math.max(env.PAPER_PROMOTION_MIN_TRADES * 2, 16);
const PAPER_SIGNAL_BLOCK_MAX_WIN_RATE_PCT = 35;
const PAPER_SIGNAL_BLOCK_MAX_AVG_PNL_PCT = 0;
const PAPER_SIGNAL_BLOCK_MAX_MEDIAN_PNL_PCT = 0.25;
const PAPER_SIGNAL_BLOCK_EXTENDED_MAX_WIN_RATE_PCT = 45;
const PAPER_SIGNAL_BLOCK_EXTENDED_MAX_AVG_PNL_PCT = 0.5;
const PAPER_SIGNAL_BLOCK_EXTENDED_MAX_MEDIAN_PNL_PCT = 0.25;
type MarketEntryPriceSource = Extract<PaperTradeRecord['entryPriceSource'], 'market-snapshot' | 'dexscreener-snapshot'>;

// Fallback auf die echte Execution-Wallet, falls WALLET_ADDRESS nicht gesetzt ist.
const executionWallet = loadExecutionWallet();
const WALLET_ADDRESS = process.env.WALLET_ADDRESS?.trim() || executionWallet.publicKey.toBase58();
const tokenScreenService = new TokenScreenService();
const dexscreenerClient = new DexscreenerClient();
const dexPairCache = new Map<string, { fetchedAt: number; pairs: DexPairSummary[] }>();
const inFlightDexPairRequests = new Map<string, Promise<DexPairSummary[]>>();

function formatSolAmount(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'n/a';
  }

  return parsed >= 0.1 ? parsed.toFixed(3) : parsed.toFixed(4);
}

function formatUsdAmount(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'n/a';
  }

  return `$${parsed >= 1000 ? parsed.toFixed(0) : parsed.toFixed(2)}`;
}

function formatPct(value: unknown, digits = 1): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'n/a';
  }

  return `${parsed.toFixed(digits)}%`;
}

function formatMetric(value: unknown, digits = 2): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'n/a';
  }

  return parsed.toFixed(digits);
}

function getExecutedBuySizeSol(executionReceipt: any, fallbackSol: number): number {
  if (executionReceipt?.inputMint === SOL_MINT) {
    const quotedLamports = Number(executionReceipt.inputAmount);
    if (Number.isFinite(quotedLamports) && quotedLamports > 0) {
      return quotedLamports / 1_000_000_000;
    }
  }

  const fallbackReceiptAmount = Number(executionReceipt?.inputAmountUi);
  if (Number.isFinite(fallbackReceiptAmount) && fallbackReceiptAmount > 0) {
    return fallbackReceiptAmount;
  }

  return fallbackSol;
}

function shouldSuppressBuyFailureTelegram(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('transactionexpiredblockheightexceedederror')
    || message.includes('block height exceeded')
    || message.includes('signature has expired');
}

function isSlippageExceededError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('slippagetoleranceexceeded')
    || message.includes('custom program error: 6001')
    || message.includes('exactoutamountnotmatched')
    || message.includes('custom program error: 6017');
}

function isVolatileBuyToken(mint: string): boolean {
  return mint.toLowerCase().endsWith('pump');
}

function getBuySlippageLadder(mint: string): number[] {
  const baseSlippage = env.MAX_JUPITER_BUY_SLIPPAGE_BPS;
  const volatileSlippage = Math.max(baseSlippage, env.MAX_JUPITER_VOLATILE_BUY_SLIPPAGE_BPS);

  if (isVolatileBuyToken(mint) && volatileSlippage > baseSlippage) {
    return [baseSlippage, volatileSlippage];
  }

  return [baseSlippage, baseSlippage];
}

async function executeBuyWithRetry(params: {
  mint: string;
  positionSol: number;
  preferredExecutionMode?: ExecutionMode;
  poolAddress?: string | null;
  dexId?: string | null;
}) {
  const { executeTradePlan } = await import('./execute-trade.js');
  const slippageLadder = getBuySlippageLadder(params.mint);
  const executionModes: ExecutionMode[] = params.preferredExecutionMode
    && params.preferredExecutionMode !== 'jupiter'
    && params.poolAddress
    ? [params.preferredExecutionMode, 'jupiter']
    : ['jupiter'];
  let lastError: unknown;

  const buildExecutionPlan = (executionMode: ExecutionMode, maxSlippageBps: number): TradePlan => ({
    planId: `AUTO-${Date.now()}-${executionMode}-${maxSlippageBps}`,
    createdAt: new Date().toISOString(),
    tokenAddress: params.mint,
    ...(params.poolAddress ? { poolAddress: params.poolAddress } : {}),
    ...(params.dexId ? { dexId: params.dexId } : {}),
    executionMode,
    requestedPositionSol: params.positionSol,
    allowedPositionSol: params.positionSol,
    currentOpenExposureSol: 0,
    projectedOpenExposureSol: params.positionSol,
    remainingExposureCapacitySol: params.positionSol,
    finalPositionSol: params.positionSol,
    maxSlippageBps,
    stopLossPct: riskConfig.stopLossPct,
    takeProfitPct: riskConfig.takeProfitPct,
    takeProfitSellFraction: riskConfig.takeProfitSellFraction,
    dryRun: false,
    requiresGo: false,
    screenPassed: true,
    executable: true,
    blockingReasons: [],
    notes: ['auto-generated live whale buy'],
  });

  for (let attemptIndex = 0; attemptIndex < slippageLadder.length; attemptIndex += 1) {
    const maxSlippageBps = slippageLadder[attemptIndex];
    if (maxSlippageBps === undefined) {
      continue;
    }

    for (let modeIndex = 0; modeIndex < executionModes.length; modeIndex += 1) {
      const executionMode = executionModes[modeIndex]!;
      const isDirectFallback = executionMode !== 'jupiter';

      try {
        console.log(`[BUY] Versuch ${attemptIndex + 1}/${slippageLadder.length} fuer ${params.mint.slice(0,6)} mit ${maxSlippageBps} bps via ${executionMode}.`);
        const receipt = await executeTradePlan(buildExecutionPlan(executionMode, maxSlippageBps));

        if (!receipt?.confirmed) {
          throw new Error(`Buy execution returned without on-chain confirmation for ${params.mint}.`);
        }

        return { receipt, maxSlippageBps, attempts: attemptIndex + 1, executionMode };
      } catch (error) {
        lastError = error;
        console.error(`[BUY] Versuch ${attemptIndex + 1}/${slippageLadder.length} fuer ${params.mint.slice(0,6)} via ${executionMode} fehlgeschlagen:`, error);

        const hasModeFallback = modeIndex < executionModes.length - 1;
        if (hasModeFallback && isDirectFallback) {
          console.warn(`[BUY] Direkter Pfad ${executionMode} fehlgeschlagen. Fallback auf Jupiter fuer ${params.mint.slice(0,6)} im selben Versuch.`);
          continue;
        }

        const canRetry = attemptIndex < slippageLadder.length - 1;
        if (!canRetry) {
          break;
        }

        if (!isSlippageExceededError(error) && !shouldSuppressBuyFailureTelegram(error)) {
          break;
        }
      }
    }

    if (lastError && !isSlippageExceededError(lastError) && !shouldSuppressBuyFailureTelegram(lastError)) {
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Buy execution failed for ${params.mint}.`);
}

type PaperTradeRecord = {
  id: string;
  whale: string;
  mint: string;
  entryPrice: number;
  openedAt: string;
  entryPriceSource: 'market-snapshot' | 'dexscreener-snapshot' | 'wallet-receipt' | 'wallet-receipt-sol-only';
  whaleWinRateAtEntry: number | null;
  entryPriceSol?: number | null;
  entryTxid?: string;
  expectedNetProfitPct?: number | null;
  rewardRiskRatio?: number | null;
  whaleBuySizeSol?: number | null;
  liquidityUsd?: number | null;
  priceExtensionPct?: number | null;
  whaleSoldFraction?: number;
  hasSeenPrice?: boolean;
  lastObservedAt?: string;
  lastObservedPrice?: number;
  lastObservedChangePct?: number;
  panic?: boolean;
  panicMarkedAt?: string;
};

type WhaleActivityRecord = {
  whale: string;
  mint: string;
  side: 'buy' | 'sell';
  detectedAt: string;
  signature?: string;
  botMode: 'paper' | 'live';
};

const whaleLogSubscriptions = new Map<string, number>();
const processedSignatures = new Map<string, number>();
const inFlightSignatures = new Set<string>();
const recentWhaleSignals = new Map<string, number>();
const recentWhaleSignalSuppressionLogs = new Map<string, number>();
const tokenPriceCache = new Map<string, { fetchedAt: number; price: number | null; source: MarketEntryPriceSource }>();
const solUsdPriceCache = { fetchedAt: 0, price: null as number | null };
let activePriceRequests = 0;
const priceRequestWaiters: Array<() => void> = [];
const limitTrackerRpc = createAsyncLimiter(TRACKER_RPC_CONCURRENCY);
const inFlightParsedTransactions = new Map<string, Promise<Awaited<ReturnType<Connection['getParsedTransaction']>> | null>>();

const getWhales = (): WhaleRecord[] => {
  try {
    return normalizeWhales(readJsonFileSync(WHALES_PATH, []));
  } catch (e) {
    return [];
  }
};

function getTrackedWhale(address: string): WhaleRecord | null {
  return getWhales().find((whale) => whale.address === address) ?? null;
}

async function removeTrackedWhaleSubscription(address: string, reason: string) {
  const subscriptionId = whaleLogSubscriptions.get(address);
  if (subscriptionId === undefined) {
    return;
  }

  try {
    await connection.removeOnLogsListener(subscriptionId);
  } catch (error) {
    console.warn(`[TRACKER] Konnte stale Subscription fuer ${address.slice(0,8)} nicht sauber entfernen:`, error);
  }

  whaleLogSubscriptions.delete(address);
  console.log(`[TRACKER] Subscription fuer ${address.slice(0,8)} entfernt (${reason}).`);
}

function readPaperTrades(): Record<string, PaperTradeRecord> {
  return readJsonFileSync(PAPER_TRADES_PATH, {});
}

function writePaperTrades(trades: Record<string, PaperTradeRecord>) {
  writeJsonFileSync(PAPER_TRADES_PATH, trades);
}

function appendWhaleActivity(entry: WhaleActivityRecord) {
  const activity = readJsonFileSync<WhaleActivityRecord[]>(WHALE_ACTIVITY_PATH, []);
  activity.unshift(entry);
  writeJsonFileSync(WHALE_ACTIVITY_PATH, activity.slice(0, 100));
  updateRuntimeStatus('tracker', {
    lastSignalAt: entry.detectedAt,
    lastSignalWhale: entry.whale,
    lastSignalMint: entry.mint,
    lastSignalSide: entry.side,
    lastSignalMode: entry.botMode,
  });
}

async function withPriceRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activePriceRequests >= TRACKER_PRICE_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      priceRequestWaiters.push(resolve);
    });
  }

  activePriceRequests += 1;
  try {
    return await operation();
  } finally {
    activePriceRequests -= 1;
    const next = priceRequestWaiters.shift();
    if (next) {
      next();
    }
  }
}

async function fetchSolUsdPrice(): Promise<number | null> {
  if (solUsdPriceCache.fetchedAt > 0 && (Date.now() - solUsdPriceCache.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
    return solUsdPriceCache.price;
  }

  return withPriceRequestSlot(async () => {
    if (solUsdPriceCache.fetchedAt > 0 && (Date.now() - solUsdPriceCache.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
      return solUsdPriceCache.price;
    }

    try {
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
      const data = await res.json();
      const price = Number(data?.data?.[SOL_MINT]?.price);
      const resolvedPrice = Number.isFinite(price) && price > 0 ? price : null;
      solUsdPriceCache.fetchedAt = Date.now();
      solUsdPriceCache.price = resolvedPrice;
      return resolvedPrice;
    } catch {
      solUsdPriceCache.fetchedAt = Date.now();
      solUsdPriceCache.price = null;
      return null;
    }
  });
}

async function fetchDexscreenerPairs(mint: string): Promise<DexPairSummary[]> {
  const cached = dexPairCache.get(mint);
  if (cached && (Date.now() - cached.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
    return cached.pairs;
  }

  const inFlight = inFlightDexPairRequests.get(mint);
  if (inFlight) {
    return inFlight;
  }

  const request = withPriceRequestSlot(async () => {
    const rechecked = dexPairCache.get(mint);
    if (rechecked && (Date.now() - rechecked.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
      return rechecked.pairs;
    }

    try {
      const pairs = (await dexscreenerClient.searchTokenPairs(mint))
        .filter((pair) => pair.chainId === 'solana');
      dexPairCache.set(mint, { fetchedAt: Date.now(), pairs });
      return pairs;
    } catch (error) {
      console.warn(`[SCREEN] Konnte Dexscreener-Paare fuer ${mint.slice(0,6)} nicht laden:`, error);
      dexPairCache.set(mint, { fetchedAt: Date.now(), pairs: [] });
      return [];
    }
  }).finally(() => {
    inFlightDexPairRequests.delete(mint);
  });

  inFlightDexPairRequests.set(mint, request);
  return request;
}

function getBestDexPriceUsd(pairs: DexPairSummary[]): number | null {
  const bestPair = [...pairs]
    .filter((pair) => Number.isFinite(Number(pair.priceUsd)) && Number(pair.priceUsd) > 0)
    .sort((left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0))[0];

  if (!bestPair) {
    return null;
  }

  const priceUsd = Number(bestPair.priceUsd);
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

function getAccountKeyString(accountKey: unknown): string | undefined {
  if (!accountKey) {
    return undefined;
  }

  if (typeof accountKey === 'string') {
    return accountKey;
  }

  if (typeof accountKey === 'object' && accountKey !== null) {
    const maybePubkey = 'pubkey' in accountKey ? (accountKey as { pubkey?: unknown }).pubkey : accountKey;
    if (typeof maybePubkey === 'string') {
      return maybePubkey;
    }

    if (typeof maybePubkey === 'object' && maybePubkey !== null && 'toBase58' in maybePubkey) {
      const toBase58 = (maybePubkey as { toBase58?: () => string }).toBase58;
      if (typeof toBase58 === 'function') {
        return toBase58.call(maybePubkey);
      }
    }
  }

  return undefined;
}

function getWalletNativeSolDelta(parsedTx: Awaited<ReturnType<Connection['getParsedTransaction']>>, walletAddress: string): number | undefined {
  const accountKeys = (parsedTx?.transaction.message as { accountKeys?: unknown[] } | undefined)?.accountKeys;
  const walletIndex = accountKeys?.findIndex((accountKey) => getAccountKeyString(accountKey) === walletAddress) ?? -1;

  if (walletIndex < 0) {
    return undefined;
  }

  const preBalance = parsedTx?.meta?.preBalances?.[walletIndex];
  const postBalance = parsedTx?.meta?.postBalances?.[walletIndex];
  if (preBalance === undefined || postBalance === undefined) {
    return undefined;
  }

  return (postBalance - preBalance) / 1_000_000_000;
}

function getReliableWhaleBuySizeSol(
  parsedTx: Awaited<ReturnType<Connection['getParsedTransaction']>> | null | undefined,
  walletAddress: string,
): number | null {
  if (!parsedTx) {
    return null;
  }

  const nativeSolDelta = getWalletNativeSolDelta(parsedTx, walletAddress);
  if (nativeSolDelta === undefined || nativeSolDelta >= 0) {
    return null;
  }

  const deployedSol = Math.abs(nativeSolDelta);
  if (deployedSol < MIN_RELIABLE_WHALE_SOL_DELTA) {
    return null;
  }

  return deployedSol;
}

function getTokenDeltaUi(parsedTx: Awaited<ReturnType<Connection['getParsedTransaction']>>, walletAddress: string, mint: string): number | undefined {
  const postBalances = parsedTx?.meta?.postTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];
  const preBalances = parsedTx?.meta?.preTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];

  const postRaw = postBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const preRaw = preBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const deltaRaw = postRaw - preRaw;
  const decimals = postBalances[0]?.uiTokenAmount.decimals ?? preBalances[0]?.uiTokenAmount.decimals ?? 0;

  if (deltaRaw === 0n) {
    return undefined;
  }

  return Number(deltaRaw < 0n ? -deltaRaw : deltaRaw) / 10 ** decimals;
}

async function inferEntryPriceFromWhaleTransaction(params: {
  parsedTx?: Awaited<ReturnType<Connection['getParsedTransaction']>> | null;
  whaleAddress: string;
  mint: string;
}): Promise<{ entryPrice: number; entryPriceSol: number | null; source: PaperTradeRecord['entryPriceSource'] } | null> {
  if (!params.parsedTx) {
    return null;
  }

  const nativeSolDelta = getWalletNativeSolDelta(params.parsedTx, params.whaleAddress);
  const tokenDeltaUi = getTokenDeltaUi(params.parsedTx, params.whaleAddress, params.mint);

  if (nativeSolDelta === undefined || nativeSolDelta >= 0 || !tokenDeltaUi || tokenDeltaUi <= 0) {
    return null;
  }

  const deployedSol = Math.abs(nativeSolDelta);
  if (deployedSol < MIN_RELIABLE_WHALE_SOL_DELTA) {
    return null;
  }

  const entryPriceSol = deployedSol / tokenDeltaUi;
  const solUsdPrice = await fetchSolUsdPrice();
  if (!solUsdPrice) {
    return {
      entryPrice: entryPriceSol,
      entryPriceSol,
      source: 'wallet-receipt-sol-only',
    };
  }

  return {
    entryPrice: entryPriceSol * solUsdPrice,
    entryPriceSol,
    source: 'wallet-receipt',
  };
}

function pruneProcessedSignatures() {
  const cutoff = Date.now() - (6 * 60 * 60 * 1000);
  for (const [signature, seenAt] of processedSignatures.entries()) {
    if (seenAt < cutoff) {
      processedSignatures.delete(signature);
    }
  }
}

function markSignatureProcessed(signature: string): boolean {
  pruneProcessedSignatures();
  if (processedSignatures.has(signature) || inFlightSignatures.has(signature)) {
    return false;
  }

  inFlightSignatures.add(signature);
  return true;
}

function finalizeSignatureProcessing(signature: string, wasHandled: boolean) {
  inFlightSignatures.delete(signature);
  if (wasHandled) {
    processedSignatures.set(signature, Date.now());
  }
}

async function getParsedTransactionQueued(signature: string): Promise<Awaited<ReturnType<Connection['getParsedTransaction']>> | null> {
  const existing = inFlightParsedTransactions.get(signature);
  if (existing) {
    return existing;
  }

  const request = limitTrackerRpc(async () => withRpcRetry(
    () => readConnection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }),
    {
      delaysMs: TRACKER_RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`[TRACKER] RPC-Limit fuer TX ${signature.slice(0,8)} erkannt. Retry ${attempt}/${TRACKER_RPC_RETRY_DELAYS_MS.length} in ${delayMs}ms.`);
      },
    },
  )).finally(() => {
    inFlightParsedTransactions.delete(signature);
  });

  inFlightParsedTransactions.set(signature, request);
  return request;
}

function pruneRecentWhaleSignals() {
  const cutoff = Date.now() - WHALE_SIGNAL_COOLDOWN_MS;
  for (const [signalKey, seenAt] of recentWhaleSignals.entries()) {
    if (seenAt < cutoff) {
      recentWhaleSignals.delete(signalKey);
    }
  }
}

function pruneRecentWhaleSignalSuppressionLogs() {
  const cutoff = Date.now() - WHALE_SIGNAL_COOLDOWN_MS;
  for (const [signalKey, seenAt] of recentWhaleSignalSuppressionLogs.entries()) {
    if (seenAt < cutoff) {
      recentWhaleSignalSuppressionLogs.delete(signalKey);
    }
  }
}

function logSuppressedWhaleSignal(whaleAddress: string, mint: string, side: 'buy' | 'sell') {
  pruneRecentWhaleSignalSuppressionLogs();
  const signalKey = `${whaleAddress}:${mint}:${side}`;
  if (recentWhaleSignalSuppressionLogs.has(signalKey)) {
    return;
  }

  recentWhaleSignalSuppressionLogs.set(signalKey, Date.now());
  console.log(`[TRACKER] Doppelte ${side === 'buy' ? 'Buy' : 'Sell'}-Erkennung fuer ${whaleAddress.slice(0,8)} ${mint.slice(0,6)} unterdrueckt.`);
}

function markWhaleSignalProcessed(whaleAddress: string, mint: string, side: 'buy' | 'sell'): boolean {
  pruneRecentWhaleSignals();
  const signalKey = `${whaleAddress}:${mint}:${side}`;
  if (recentWhaleSignals.has(signalKey)) {
    return false;
  }

  recentWhaleSignals.set(signalKey, Date.now());
  return true;
}

type WhalePerformanceProfile = {
  sampleSize: number;
  winRate: number | null;
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  tier: 'test' | 'caution' | 'standard' | 'elite' | 'blocked';
  sourceMode: 'paper' | 'live';
};

function formatPerformanceLabel(positionProfile: WhalePerformanceProfile): string {
  return positionProfile.winRate === null
    ? `${positionProfile.sampleSize} Trades (${positionProfile.sourceMode})`
    : `${formatPct(positionProfile.winRate, 0)} Win / Avg ${formatPct(positionProfile.avgPnlPct, 1)} aus ${positionProfile.sampleSize} ${positionProfile.sourceMode}`;
}

type PositionSizingDecision = {
  executable: boolean;
  positionSol: number;
  walletBalanceSol: number;
  availableWalletSol: number;
  currentOpenExposureSol: number;
  remainingExposureCapacitySol: number;
  remainingCapitalAtRiskSol: number;
  riskBudgetSol: number;
  effectiveLossPct: number;
  blockingReason?: string;
};

type EntryDecision = {
  allowed: boolean;
  entryPrice: number | null;
  entryPriceSol: number | null;
  entryPriceSource: PaperTradeRecord['entryPriceSource'];
  marketEntryPriceUsd: number | null;
  whaleEntryPriceUsd: number | null;
  whaleBuySizeSol: number | null;
  liquidityUsd: number | null;
  priceExtensionPct: number | null;
  expectedNetProfitPct: number | null;
  rewardRiskRatio: number | null;
  poolAddress: string | null;
  dexId: string | null;
  preferredExecutionMode: ExecutionMode;
  rejectionReasons: string[];
  notes: string[];
};

function logSizingConfiguration() {
  console.log('[CONFIG] Whale sizing geladen:', {
    walletAddress: WALLET_ADDRESS,
    maxPositionSol: riskConfig.maxPositionSol,
    minLiveTradeSizeSol: riskConfig.minLiveTradeSizeSol,
    riskPerTradePct: riskConfig.riskPerTradePct,
    maxCapitalAtRiskPct: riskConfig.maxCapitalAtRiskPct,
    stopLossPct: riskConfig.stopLossPct,
    takeProfitPct: riskConfig.takeProfitPct,
    estimatedRoundTripCostBps: riskConfig.estimatedRoundTripCostBps,
    baseBuySlippageBps: env.MAX_JUPITER_BUY_SLIPPAGE_BPS,
    volatileBuySlippageBps: env.MAX_JUPITER_VOLATILE_BUY_SLIPPAGE_BPS,
    minEntryLiquidityUsd: env.MIN_ENTRY_LIQUIDITY_USD,
    minWhaleBuySizeSol: env.MIN_WHALE_BUY_SIZE_SOL,
    maxEntryPriceExtensionPct: env.MAX_ENTRY_PRICE_EXTENSION_PCT,
  });
}

function shouldBlockPaperSignals(summary: WhaleModeSummary): boolean {
  if (summary.evaluatedTrades < PAPER_SIGNAL_BLOCK_MIN_TRADES) {
    return false;
  }

  const winRate = summary.winRatePct;
  const avgPnlPct = summary.avgPnlPct;
  const medianPnlPct = summary.medianPnlPct ?? avgPnlPct;
  if (winRate === null || avgPnlPct === null || medianPnlPct === null) {
    return false;
  }

  const clearlyWeak = winRate < PAPER_SIGNAL_BLOCK_MAX_WIN_RATE_PCT
    && avgPnlPct <= PAPER_SIGNAL_BLOCK_MAX_AVG_PNL_PCT
    && medianPnlPct <= PAPER_SIGNAL_BLOCK_MAX_MEDIAN_PNL_PCT;
  if (clearlyWeak) {
    return true;
  }

  return summary.evaluatedTrades >= PAPER_SIGNAL_BLOCK_EXTENDED_TRADES
    && winRate < PAPER_SIGNAL_BLOCK_EXTENDED_MAX_WIN_RATE_PCT
    && avgPnlPct <= PAPER_SIGNAL_BLOCK_EXTENDED_MAX_AVG_PNL_PCT
    && medianPnlPct <= PAPER_SIGNAL_BLOCK_EXTENDED_MAX_MEDIAN_PNL_PCT;
}

function getPaperSignalBlockReason(profile: WhalePerformanceProfile): string | null {
  if (profile.sourceMode !== 'paper' || profile.tier !== 'blocked') {
    return null;
  }

  const winRate = profile.winRate;
  const avgPnlPct = profile.avgPnlPct;
  const medianPnlPct = profile.medianPnlPct ?? avgPnlPct;
  if (winRate === null || avgPnlPct === null || medianPnlPct === null) {
    return 'Paper-Wal ist nach Historie blockiert.';
  }

  const blockProfile = profile.sampleSize >= PAPER_SIGNAL_BLOCK_EXTENDED_TRADES
    ? {
        minTrades: PAPER_SIGNAL_BLOCK_EXTENDED_TRADES,
        maxWinRate: PAPER_SIGNAL_BLOCK_EXTENDED_MAX_WIN_RATE_PCT,
        maxAvgPnl: PAPER_SIGNAL_BLOCK_EXTENDED_MAX_AVG_PNL_PCT,
        maxMedianPnl: PAPER_SIGNAL_BLOCK_EXTENDED_MAX_MEDIAN_PNL_PCT,
      }
    : {
        minTrades: PAPER_SIGNAL_BLOCK_MIN_TRADES,
        maxWinRate: PAPER_SIGNAL_BLOCK_MAX_WIN_RATE_PCT,
        maxAvgPnl: PAPER_SIGNAL_BLOCK_MAX_AVG_PNL_PCT,
        maxMedianPnl: PAPER_SIGNAL_BLOCK_MAX_MEDIAN_PNL_PCT,
      };

  return `Paper-Wal pausiert: ${profile.sampleSize} Trades, Win-Rate ${winRate.toFixed(0)}% <= ${blockProfile.maxWinRate.toFixed(0)}%, Avg ${avgPnlPct.toFixed(2)}% <= ${blockProfile.maxAvgPnl.toFixed(2)}%, Median ${medianPnlPct.toFixed(2)}% <= ${blockProfile.maxMedianPnl.toFixed(2)}%.`;
}

function getPositionSizeProfile(whale: WhaleRecord): WhalePerformanceProfile {
  try {
    const liveSummary = getWhaleModeSummary(whale.address, 'live');
    const paperSummary = getWhaleModeSummary(whale.address, 'paper');
    const sourceMode = whale.mode === 'live' && liveSummary.evaluatedTrades > 0 ? 'live' : 'paper';
    const summary = sourceMode === 'live' ? liveSummary : paperSummary;

    let tier: WhalePerformanceProfile['tier'] = 'test';
    if (summary.evaluatedTrades >= env.PAPER_PROMOTION_MIN_TRADES) {
      if ((summary.winRatePct ?? 0) >= 70 && (summary.avgPnlPct ?? 0) >= env.PAPER_PROMOTION_MIN_AVG_PNL_PCT * 1.5) {
        tier = 'elite';
      } else if ((summary.winRatePct ?? 100) < 50 || (summary.avgPnlPct ?? 0) < 0) {
        tier = 'caution';
      } else {
        tier = 'standard';
      }
    } else if (summary.evaluatedTrades >= 3) {
      tier = (summary.avgPnlPct ?? 0) < 0 ? 'caution' : 'standard';
    }

    if (sourceMode === 'paper' && shouldBlockPaperSignals(summary)) {
      tier = 'blocked';
    }

    return {
      sampleSize: summary.evaluatedTrades,
      winRate: summary.winRatePct,
      avgPnlPct: summary.avgPnlPct,
      medianPnlPct: summary.medianPnlPct,
      tier,
      sourceMode,
    };
  } catch (error) {
    console.error("Konnte Wal-Performance nicht auswerten:", error);
    return {
      sampleSize: 0,
      winRate: null,
      avgPnlPct: null,
      medianPnlPct: null,
      tier: 'test',
      sourceMode: whale.mode,
    };
  }
}

function getOpenExposureSnapshot() {
  const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
  const effectiveLossPct = riskConfig.stopLossPct + (riskConfig.estimatedRoundTripCostBps / 100);
  const effectiveLossFraction = effectiveLossPct / 100;
  let currentOpenExposureSol = 0;
  let capitalAtRiskUsedSol = 0;

  for (const tradeData of Object.values(activeTrades)) {
    if (!tradeData || typeof tradeData !== 'object') {
      continue;
    }

    if (tradeData.exiting) {
      continue;
    }

    const positionSol = Number(tradeData.positionSol);
    if (!Number.isFinite(positionSol) || positionSol <= 0) {
      continue;
    }

    const remainingFraction = Number.isFinite(Number(tradeData.remainingPositionFraction))
      ? Math.min(1, Math.max(0, Number(tradeData.remainingPositionFraction)))
      : 1;
    const effectivePositionSol = positionSol * remainingFraction;
    currentOpenExposureSol += effectivePositionSol;
    capitalAtRiskUsedSol += effectivePositionSol * effectiveLossFraction;
  }

  return {
    currentOpenExposureSol,
    remainingExposureCapacitySol: Math.max(0, riskConfig.maxOpenExposureSol - currentOpenExposureSol),
    capitalAtRiskUsedSol,
    effectiveLossPct,
  };
}

async function calculatePositionSize(): Promise<PositionSizingDecision> {
  const balanceLamports = await withRpcRetry(
    () => connection.getBalance(new PublicKey(WALLET_ADDRESS), 'confirmed'),
    {
      delaysMs: TRACKER_RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`[TRACKER] RPC-Limit beim Wallet-Balance-Check erkannt. Retry ${attempt}/${TRACKER_RPC_RETRY_DELAYS_MS.length} in ${delayMs}ms.`);
      },
    },
  );

  const walletBalanceSol = balanceLamports / 1_000_000_000;
  const availableWalletSol = Math.max(0, walletBalanceSol - MIN_SOL_RESERVE);
  const exposure = getOpenExposureSnapshot();
  const maxCapitalAtRiskSol = walletBalanceSol * (riskConfig.maxCapitalAtRiskPct / 100);
  const remainingCapitalAtRiskSol = Math.max(0, maxCapitalAtRiskSol - exposure.capitalAtRiskUsedSol);
  const riskBudgetSol = Math.min(walletBalanceSol * (riskConfig.riskPerTradePct / 100), remainingCapitalAtRiskSol);
  const effectiveLossFraction = exposure.effectiveLossPct / 100;
  const uncappedPositionSol = effectiveLossFraction > 0 ? riskBudgetSol / effectiveLossFraction : 0;
  const positionSol = Math.min(
    uncappedPositionSol,
    availableWalletSol,
    exposure.remainingExposureCapacitySol,
    riskConfig.maxPositionSol,
  );

  if (availableWalletSol < riskConfig.minLiveTradeSizeSol) {
    return {
      executable: false,
      positionSol: 0,
      walletBalanceSol,
      availableWalletSol,
      currentOpenExposureSol: exposure.currentOpenExposureSol,
      remainingExposureCapacitySol: exposure.remainingExposureCapacitySol,
      remainingCapitalAtRiskSol,
      riskBudgetSol,
      effectiveLossPct: exposure.effectiveLossPct,
      blockingReason: `Wallet nach Reserve zu klein (${availableWalletSol.toFixed(3)} SOL frei).`,
    };
  }

  if (exposure.remainingExposureCapacitySol < riskConfig.minLiveTradeSizeSol) {
    return {
      executable: false,
      positionSol: 0,
      walletBalanceSol,
      availableWalletSol,
      currentOpenExposureSol: exposure.currentOpenExposureSol,
      remainingExposureCapacitySol: exposure.remainingExposureCapacitySol,
      remainingCapitalAtRiskSol,
      riskBudgetSol,
      effectiveLossPct: exposure.effectiveLossPct,
      blockingReason: `Open-Exposure voll (${exposure.currentOpenExposureSol.toFixed(3)} SOL offen).`,
    };
  }

  if (remainingCapitalAtRiskSol <= 0 || riskBudgetSol <= 0) {
    return {
      executable: false,
      positionSol: 0,
      walletBalanceSol,
      availableWalletSol,
      currentOpenExposureSol: exposure.currentOpenExposureSol,
      remainingExposureCapacitySol: exposure.remainingExposureCapacitySol,
      remainingCapitalAtRiskSol,
      riskBudgetSol,
      effectiveLossPct: exposure.effectiveLossPct,
      blockingReason: 'Kapital-im-Risiko-Limit bereits ausgeschöpft.',
    };
  }

  if (!Number.isFinite(positionSol) || positionSol < riskConfig.minLiveTradeSizeSol) {
    return {
      executable: false,
      positionSol: Number.isFinite(positionSol) ? positionSol : 0,
      walletBalanceSol,
      availableWalletSol,
      currentOpenExposureSol: exposure.currentOpenExposureSol,
      remainingExposureCapacitySol: exposure.remainingExposureCapacitySol,
      remainingCapitalAtRiskSol,
      riskBudgetSol,
      effectiveLossPct: exposure.effectiveLossPct,
      blockingReason: `Risk-basiertes Sizing ergibt nur ${Number.isFinite(positionSol) ? positionSol.toFixed(3) : '0.000'} SOL und liegt unter Minimum.`,
    };
  }

  return {
    executable: true,
    positionSol,
    walletBalanceSol,
    availableWalletSol,
    currentOpenExposureSol: exposure.currentOpenExposureSol,
    remainingExposureCapacitySol: exposure.remainingExposureCapacitySol,
    remainingCapitalAtRiskSol,
    riskBudgetSol,
    effectiveLossPct: exposure.effectiveLossPct,
  };
}

async function getLiquidityUsd(mint: string): Promise<number | null> {
  const pairs = await fetchDexscreenerPairs(mint);
  const bestLiquidity = pairs
    .map((pair) => Number(pair.liquidity?.usd))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left)[0];

  return bestLiquidity !== undefined && Number.isFinite(bestLiquidity) ? bestLiquidity : null;
}

async function getPriceExtensionPct(params: {
  marketEntryPriceUsd: number | null;
  whaleEntry: Awaited<ReturnType<typeof inferEntryPriceFromWhaleTransaction>>;
}): Promise<number | null> {
  const { marketEntryPriceUsd, whaleEntry } = params;
  if (!marketEntryPriceUsd || !whaleEntry) {
    return null;
  }

  if (whaleEntry.source === 'wallet-receipt' && whaleEntry.entryPrice > 0) {
    return ((marketEntryPriceUsd - whaleEntry.entryPrice) / whaleEntry.entryPrice) * 100;
  }

  if (whaleEntry.source === 'wallet-receipt-sol-only' && whaleEntry.entryPriceSol) {
    const solUsdPrice = await fetchSolUsdPrice();
    if (!solUsdPrice || solUsdPrice <= 0) {
      return null;
    }

    const currentPriceSol = marketEntryPriceUsd / solUsdPrice;
    return ((currentPriceSol - whaleEntry.entryPriceSol) / whaleEntry.entryPriceSol) * 100;
  }

  return null;
}

function isSoftPaperTokenScreenFailure(screen: TokenSecurityScreen): boolean {
  if (!screen.mintAuthorityRevoked || !screen.freezeAuthorityRevoked) {
    return false;
  }

  const reasons = screen.reasons.map((reason) => reason.toLowerCase());
  return screen.liquidityCheckStatus === 'unknown'
    && reasons.some((reason) => reason.includes('unable to determine lp mint address'));
}

async function evaluateEntryDecision(
  whale: WhaleRecord,
  mint: string,
  parsedTx?: Awaited<ReturnType<Connection['getParsedTransaction']>> | null,
): Promise<EntryDecision> {
  const rejectionReasons: string[] = [];
  const notes: string[] = [];
  let poolAddress: string | null = null;
  let dexId: string | null = null;
  let preferredExecutionMode: ExecutionMode = 'jupiter';
  const marketEntry = await fetchEntryPriceUsd(mint);
  const marketEntryPriceUsd = marketEntry.price;
  const whaleEntry = await inferEntryPriceFromWhaleTransaction({ ...(parsedTx !== undefined ? { parsedTx } : {}), whaleAddress: whale.address, mint });
  const entryPrice = marketEntryPriceUsd ?? whaleEntry?.entryPrice ?? null;
  const entryPriceSource = marketEntryPriceUsd ? marketEntry.source : (whaleEntry?.source ?? 'market-snapshot');
  const liquidityUsd = await getLiquidityUsd(mint);
  const whaleBuySizeSol = getReliableWhaleBuySizeSol(parsedTx, whale.address);

  if (entryPrice === null || entryPrice <= 0) {
    rejectionReasons.push('Kein belastbarer Einstiegspreis verfuegbar.');
  }

  if (!Number.isFinite(Number(liquidityUsd)) || Number(liquidityUsd) < env.MIN_ENTRY_LIQUIDITY_USD) {
    rejectionReasons.push(`Liquiditaet ${Number.isFinite(Number(liquidityUsd)) ? `$${Number(liquidityUsd).toFixed(0)}` : 'unbekannt'} unter Minimum $${env.MIN_ENTRY_LIQUIDITY_USD}.`);
  }

  if (whaleBuySizeSol !== null && whaleBuySizeSol < env.MIN_WHALE_BUY_SIZE_SOL) {
    rejectionReasons.push(`Whale-Buy nur ${whaleBuySizeSol.toFixed(3)} SOL, Minimum ${env.MIN_WHALE_BUY_SIZE_SOL.toFixed(3)} SOL.`);
  }

  const priceExtensionPct = await getPriceExtensionPct({ marketEntryPriceUsd, whaleEntry });
  if (priceExtensionPct !== null && priceExtensionPct > env.MAX_ENTRY_PRICE_EXTENSION_PCT) {
    rejectionReasons.push(`Entry bereits ${priceExtensionPct.toFixed(1)}% ueber Whale-Fill.`);
  }

  const effectiveExtensionPct = priceExtensionPct === null ? 0 : Math.max(0, priceExtensionPct);
  const roundTripCostPct = riskConfig.estimatedRoundTripCostBps / 100;
  const expectedNetProfitPct = riskConfig.takeProfitPct - effectiveExtensionPct - roundTripCostPct;
  const expectedLossPct = riskConfig.stopLossPct + roundTripCostPct;
  const rewardRiskRatio = expectedLossPct > 0 ? expectedNetProfitPct / expectedLossPct : null;

  if (expectedNetProfitPct < env.MIN_EXPECTED_NET_PROFIT_PCT) {
    rejectionReasons.push(`Netto-Erwartung ${expectedNetProfitPct.toFixed(1)}% unter Mindestwert ${env.MIN_EXPECTED_NET_PROFIT_PCT.toFixed(1)}%.`);
  }

  if (rewardRiskRatio !== null && rewardRiskRatio < env.MIN_REWARD_RISK_RATIO) {
    rejectionReasons.push(`Reward/Risk ${rewardRiskRatio.toFixed(2)} unter ${env.MIN_REWARD_RISK_RATIO.toFixed(2)}.`);
  }

  if (whaleBuySizeSol === null) {
    notes.push('Whale-Buy-Groesse konnte nicht belastbar in SOL abgeleitet werden.');
  }

  if (rejectionReasons.length === 0) {
    try {
      const screen = await tokenScreenService.screenToken(mint, {
        skipLiquidityChecks: whale.mode === 'paper',
      });
      if (!screen.passed) {
        if (whale.mode === 'paper' && isSoftPaperTokenScreenFailure(screen)) {
          notes.push(`Token-Screen unvollstaendig: ${(screen.reasons[0] ?? 'unbekannt').slice(0, 160)} Paper-Trade wird trotzdem bewertet.`);
        } else {
          rejectionReasons.push(`Token-Screen fehlgeschlagen: ${(screen.reasons[0] ?? 'unbekannt').slice(0, 160)}`);
        }
      }
      poolAddress = screen.liquidity?.pool?.pairAddress ?? null;
      dexId = screen.liquidity?.pool?.dexId ?? null;
      preferredExecutionMode = chooseHotExecutionMode({
        mint,
        dexId,
        liquidityUsd,
        whaleBuySizeSol,
      });
      if (screen.warnings.length > 0) {
        notes.push(screen.warnings[0]!);
      }
    } catch (error) {
      if (whale.mode === 'paper' && isSolanaRpcRateLimitError(error)) {
        notes.push('Token-Screen temporär rate-limited, Paper-Trade wird trotzdem bewertet.');
      } else {
        rejectionReasons.push(`Token-Screen Fehler: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    allowed: rejectionReasons.length === 0,
    entryPrice,
    entryPriceSol: whaleEntry?.entryPriceSol ?? null,
    entryPriceSource,
    marketEntryPriceUsd,
    whaleEntryPriceUsd: whaleEntry?.source === 'wallet-receipt' ? whaleEntry.entryPrice : null,
    whaleBuySizeSol,
    liquidityUsd,
    priceExtensionPct,
    expectedNetProfitPct,
    rewardRiskRatio,
    poolAddress,
    dexId,
    preferredExecutionMode,
    rejectionReasons,
    notes,
  };
}

async function fetchEntryPriceUsd(mint: string): Promise<{ price: number | null; source: MarketEntryPriceSource }> {
  const cached = tokenPriceCache.get(mint);
  if (cached && (Date.now() - cached.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
    return { price: cached.price, source: cached.source };
  }

  return withPriceRequestSlot(async () => {
    const rechecked = tokenPriceCache.get(mint);
    if (rechecked && (Date.now() - rechecked.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
      return { price: rechecked.price, source: rechecked.source };
    }

    try {
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
      const data = await res.json();
      const price = Number(data?.data?.[mint]?.price);
      if (Number.isFinite(price) && price > 0) {
        tokenPriceCache.set(mint, { fetchedAt: Date.now(), price, source: 'market-snapshot' });
        return { price, source: 'market-snapshot' };
      }
    } catch (error) {
      console.error(`Konnte Einstiegspreis fuer ${mint.slice(0,6)} nicht laden:`, error);
    }

    const dexPriceUsd = getBestDexPriceUsd(await fetchDexscreenerPairs(mint));
    tokenPriceCache.set(mint, { fetchedAt: Date.now(), price: dexPriceUsd, source: 'dexscreener-snapshot' });
    return { price: dexPriceUsd, source: 'dexscreener-snapshot' };
  });
}

// --- KAUF LOGIK (Mit Kassenzettel-System!) ---
async function openPaperTrade(
  whale: WhaleRecord,
  mint: string,
  positionProfile: WhalePerformanceProfile,
  entryDecision: EntryDecision,
  signature?: string,
) {
  const entryPrice = entryDecision.entryPrice;

  if (!entryPrice) {
    console.warn(`[PAPER] ${mint.slice(0,6)} fuer ${whale.address.slice(0,8)} konnte ohne Einstiegspreis nicht als Paper-Trade angelegt werden.`);
    return;
  }

  const paperTrades = readPaperTrades();
  const tradeId = `${whale.address}:${mint}`;
  if (paperTrades[tradeId]) {
    return;
  }

  const paperTradeRecord: PaperTradeRecord = {
    id: tradeId,
    whale: whale.address,
    mint,
    entryPrice,
    openedAt: new Date().toISOString(),
    entryPriceSource: entryDecision.entryPriceSource,
    whaleWinRateAtEntry: positionProfile.winRate,
    entryPriceSol: entryDecision.entryPriceSol,
    expectedNetProfitPct: entryDecision.expectedNetProfitPct ?? null,
    rewardRiskRatio: entryDecision.rewardRiskRatio ?? null,
    whaleBuySizeSol: entryDecision.whaleBuySizeSol ?? null,
    liquidityUsd: entryDecision.liquidityUsd ?? null,
    priceExtensionPct: entryDecision.priceExtensionPct ?? null,
  };
  if (signature) {
    paperTradeRecord.entryTxid = signature;
  }

  paperTrades[tradeId] = paperTradeRecord;
  writePaperTrades(paperTrades);
  console.log(`[PAPER] Neuer Schatten-Trade fuer ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)} gespeichert (${paperTradeRecord.entryPriceSource}).`);
}

function getLiveTradeBlockReason(whale: WhaleRecord): string | null {
  if (whale.mode !== 'live') {
    return 'candidate still in paper mode';
  }

  if (!whale.promotedAt) {
    return 'candidate not yet validated for live auto-buy';
  }

  return null;
}

async function logDecision(
  whale: WhaleRecord,
  mint: string,
  parsedTx?: Awaited<ReturnType<Connection['getParsedTransaction']>> | null,
  signature?: string,
) {
  const positionProfile = getPositionSizeProfile(whale);
  const paperSignalBlockReason = whale.mode === 'paper'
    ? getPaperSignalBlockReason(positionProfile)
    : null;

  if (paperSignalBlockReason) {
    console.log(`[BUY] ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)} blockiert: ${paperSignalBlockReason}`);
    updateRuntimeStatus('tracker', {
      lastBlockedPaperSignalAt: new Date().toISOString(),
      lastBlockedPaperWhale: whale.address,
      lastBlockedPaperMint: mint,
      lastBlockedPaperReason: paperSignalBlockReason,
    });
    return;
  }

  const entryDecision = await evaluateEntryDecision(whale, mint, parsedTx);

  const performanceLabel = formatPerformanceLabel(positionProfile);

  console.log(`[BUY] Entscheidung fuer ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)}... mode=${whale.mode} tier=${positionProfile.tier} perf=${performanceLabel} liq=${formatUsdAmount(entryDecision.liquidityUsd)} ext=${formatPct(entryDecision.priceExtensionPct, 1)} rr=${formatMetric(entryDecision.rewardRiskRatio, 2)} exec=${entryDecision.preferredExecutionMode}${entryDecision.dexId ? ` dex=${entryDecision.dexId}` : ''}`);

  if (!entryDecision.allowed) {
    console.log(`[BUY] ${mint.slice(0,6)} uebersprungen: ${entryDecision.rejectionReasons.join(' | ')}`);
    return;
  }

  if (whale.mode === 'paper') {
    await openPaperTrade(whale, mint, positionProfile, entryDecision, signature);
    return;
  }

  const liveTradeBlockReason = getLiveTradeBlockReason(whale);

  if (liveTradeBlockReason) {
    console.log(`[BUY] ${mint.slice(0,6)} nicht live gehandelt: ${liveTradeBlockReason}. Signal wird nur als Paper-Trade gespiegelt.`);
    updateRuntimeStatus('tracker', {
      lastBlockedLiveSignalAt: new Date().toISOString(),
      lastBlockedLiveWhale: whale.address,
      lastBlockedLiveMint: mint,
      lastBlockedLiveReason: liveTradeBlockReason,
    });
    await openPaperTrade(whale, mint, positionProfile, entryDecision, signature);
    await sendTelegram(`🛑 <b>LIVE-BUY BLOCKIERT</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nGrund: <b>${liveTradeBlockReason}</b>\nAktion: Signal nur als Paper-Trade erfasst.`, {
      dedupeKey: `live-buy-blocked:${whale.address}:${mint}:${liveTradeBlockReason}`,
      cooldownMs: 60 * 60 * 1000,
    });
    return;
  }

  try {
    const sizingDecision = await calculatePositionSize();
    if (!sizingDecision.executable) {
      console.log(`[BUY] ${mint.slice(0,6)} nicht live gehandelt: ${sizingDecision.blockingReason}`);
      return;
    }

    const { receipt: executionReceipt, maxSlippageBps, attempts, executionMode } = await executeBuyWithRetry({
      mint,
      positionSol: sizingDecision.positionSol,
      preferredExecutionMode: entryDecision.preferredExecutionMode,
      poolAddress: entryDecision.poolAddress,
      dexId: entryDecision.dexId,
    });

    const entryPrice = executionReceipt?.fillPriceUsd ?? entryDecision.marketEntryPriceUsd ?? entryDecision.entryPrice;
    if (!executionReceipt?.confirmed) {
      throw new Error(`Trade for ${mint} was not confirmed on-chain and will not be persisted.`);
    }

    if (!entryPrice) {
      await sendTelegram(`⚠️ <b>ENTRY PRICE UNBEKANNT</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nTrade wurde ausgefuehrt, aber der Fill-Preis konnte nicht berechnet werden.`, {
        dedupeKey: `entry-price-unknown:${mint}`,
        cooldownMs: 6 * 60 * 60 * 1000,
      });
    }

    const fillSource = executionReceipt?.priceSource ?? entryDecision.entryPriceSource;
    const fillTxid = executionReceipt?.txid;
    const fillPriceSol = executionReceipt?.fillPriceSol ?? entryDecision.entryPriceSol;
    if (entryPrice) {
      console.log(`[KASSENZETTEL] Kaufpreis fuer ${mint.slice(0,6)} gesichert: $${entryPrice} (${fillSource})`);
    } else {
      console.warn(`[KASSENZETTEL] Kaufpreis fuer ${mint.slice(0,6)} noch unbekannt. Trade wird trotzdem als aktiv gespeichert.`);
    }

    let activeTrades: any = readJsonFileSync(ACTIVE_TRADES_PATH, {});
    const actualSizeSol = getExecutedBuySizeSol(executionReceipt, sizingDecision.positionSol);

    // NEU: Wir speichern jetzt das Hybrid-Objekt inkl. Preis und Wal-Adresse!
    activeTrades[mint] = {
      whale: whale.address,
      entryPrice: entryPrice ?? null,
      openedAt: new Date().toISOString(),
      balanceCheckGraceUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      positionSol: actualSizeSol,
      whaleWinRateAtEntry: positionProfile.winRate,
      whaleAvgPnlAtEntry: positionProfile.avgPnlPct,
      entryPriceSource: fillSource,
      entryTxid: fillTxid,
      entryPriceSol: fillPriceSol ?? null,
      entryAmountRaw: executionReceipt?.outputAmount ?? null,
      entryAmountUi: executionReceipt?.outputAmountUi ?? null,
      remainingPositionFraction: 1,
      realizedSoldFraction: 0,
      realizedPnlPct: 0,
      takeProfitTaken: false,
      whaleBuySizeSol: entryDecision.whaleBuySizeSol ?? null,
      liquidityUsd: entryDecision.liquidityUsd ?? null,
      dexId: entryDecision.dexId ?? null,
      poolAddress: entryDecision.poolAddress ?? null,
      executionMode,
      priceExtensionPct: entryDecision.priceExtensionPct ?? null,
      expectedNetProfitPct: entryDecision.expectedNetProfitPct ?? null,
      rewardRiskRatio: entryDecision.rewardRiskRatio ?? null,
      riskBudgetSol: sizingDecision.riskBudgetSol,
      effectiveLossPct: sizingDecision.effectiveLossPct,
    };

    writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);

    const persistedTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
    const activeCount = Object.keys(persistedTrades).length;

    await sendTelegram(`🚀 <b>WAL-SIGNAL GEKAUFT</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nGroesse: ${formatSolAmount(actualSizeSol)} SOL\nRisk-Budget: <b>${formatSolAmount(sizingDecision.riskBudgetSol)} SOL</b> bei ${sizingDecision.effectiveLossPct.toFixed(1)}% Risiko\nEdge: <b>${entryDecision.expectedNetProfitPct?.toFixed(1) ?? 'n/a'}%</b> netto | RR <b>${entryDecision.rewardRiskRatio?.toFixed(2) ?? 'n/a'}</b>\nWin-Rate: ${formatPerformanceLabel(positionProfile)}\nModus: ${positionProfile.tier}\nExecution: <b>${executionMode}</b>${entryDecision.dexId ? ` via ${entryDecision.dexId}` : ''}\nKaufversuche: <b>${attempts}</b>\nSlippage: <b>${maxSlippageBps} bps</b>\nAktive Positionen: <b>${activeCount}</b>\nQuelle: ${fillSource}${fillTxid ? `\nTx: <code>${fillTxid}</code>` : ''}`, {
      dedupeKey: `buy-success:${mint}:${fillTxid ?? 'no-txid'}`,
      cooldownMs: 300_000,
      priority: true,
    });

  } catch (e: any) {
    console.error(`❌ [BUY] Kauf fuer ${mint.slice(0,6)} fehlgeschlagen:`, e);

    if (shouldSuppressBuyFailureTelegram(e)) {
      console.warn(`[BUY] Telegram-Alarm fuer temporaeren Confirm/Broadcast-Fehler unterdrueckt: ${e.message}`);
      return;
    }

    await sendTelegram(`❌ <b>KAUF FEHLGESCHLAGEN</b>\nFehler: ${e.message}`, {
      dedupeKey: `buy-failed:${mint}:${e.message}`,
      cooldownMs: 300_000,
      priority: true,
    });
  }
}

// --- VERKAUFS LOGIK (Trim vs. Panik-Exit) ---
async function executePanicSell(whale: WhaleRecord, mint: string, soldFractionPct: number) {
  console.log(`🚨 [WHALE SELL] Wal ${whale.address.slice(0,6)} verkauft ${mint.slice(0,6)} (${soldFractionPct.toFixed(1)}%).`);

  try {
    const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
    const activeTrade = activeTrades[mint];
    const currentSoldFraction = Math.min(1, Math.max(0, soldFractionPct / 100));

    // Prüfen, ob wir den Token überhaupt noch haben
    if (!activeTrade) {
      const paperTrades = readPaperTrades();
      const paperTradeId = `${whale.address}:${mint}`;

      if (!paperTrades[paperTradeId]) {
        await sendTelegram(`ℹ <b>INFO</b>\nToken: ${mint.slice(0,6)}...\nWal hat verkauft, aber wir waren schon vorher draußen!`, {
          dedupeKey: `already-out:${mint}`,
          cooldownMs: 60 * 60 * 1000,
        });
        return;
      }

      const existingSoldFraction = Number(paperTrades[paperTradeId].whaleSoldFraction);
      const baseSoldFraction = Number.isFinite(existingSoldFraction) ? Math.min(1, Math.max(0, existingSoldFraction)) : 0;
      const cumulativeSoldFraction = baseSoldFraction + ((1 - baseSoldFraction) * currentSoldFraction);
      const cumulativeSoldFractionPct = cumulativeSoldFraction * 100;
      paperTrades[paperTradeId].whaleSoldFraction = cumulativeSoldFraction;

      if (cumulativeSoldFractionPct < env.WHALE_SELL_TRIM_IGNORE_FRACTION_PCT) {
        writePaperTrades(paperTrades);
        console.log(`[PAPER] Whale-Sell ${cumulativeSoldFractionPct.toFixed(1)}% fuer ${mint.slice(0,6)} noch unter Ignore-Schwelle.`);
        return;
      }

      const shouldPanic = cumulativeSoldFractionPct >= env.WHALE_PANIC_SELL_MIN_FRACTION_PCT;
      if (shouldPanic) {
        paperTrades[paperTradeId].panic = true;
        paperTrades[paperTradeId].panicMarkedAt = new Date().toISOString();
        writePaperTrades(paperTrades);
        console.log(`[PAPER] Token ${mint.slice(0,6)} fuer Schatten-Exit markiert.`);
      } else {
        writePaperTrades(paperTrades);
        console.log(`[PAPER] Whale-Trim ${soldFractionPct.toFixed(1)}% fuer ${mint.slice(0,6)} notiert, aber kein Voll-Exit.`);
      }
      return;
    }

    const existingTrimFraction = Number(activeTrade.whaleSoldFraction ?? activeTrade.whaleTrimFraction);
    const baseSoldFraction = Number.isFinite(existingTrimFraction) ? Math.min(1, Math.max(0, existingTrimFraction)) : 0;
    const cumulativeSoldFraction = baseSoldFraction + ((1 - baseSoldFraction) * currentSoldFraction);
    const cumulativeSoldFractionPct = cumulativeSoldFraction * 100;

    if (cumulativeSoldFractionPct < env.WHALE_SELL_TRIM_IGNORE_FRACTION_PCT) {
      activeTrades[mint].whaleSoldFraction = cumulativeSoldFraction;
      activeTrades[mint].whaleTrimMarkedAt = new Date().toISOString();
      writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);
      console.log(`[WHALE SELL] ${mint.slice(0,6)} ignoriert: kumuliert ${cumulativeSoldFractionPct.toFixed(1)}% unter ${env.WHALE_SELL_TRIM_IGNORE_FRACTION_PCT}%.`);
      return;
    }

    const shouldPanic = cumulativeSoldFractionPct >= env.WHALE_PANIC_SELL_MIN_FRACTION_PCT;

    if (!shouldPanic) {
      activeTrades[mint].whaleTrimFraction = cumulativeSoldFraction;
      activeTrades[mint].whaleSoldFraction = cumulativeSoldFraction;
      activeTrades[mint].whaleTrimMarkedAt = new Date().toISOString();
      writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);

      await sendTelegram(`✂️ <b>WAL TRIM ERKANNT</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nWhale hat kumuliert ca. <b>${cumulativeSoldFractionPct.toFixed(1)}%</b> verkauft. Bot trimmt nur teilweise.`, {
        dedupeKey: `whale-trim:${whale.address}:${mint}`,
        cooldownMs: 30 * 60 * 1000,
      });
      console.log(`[TRIM] Token ${mint.slice(0,6)} fuer Teilverkauf mit ${cumulativeSoldFraction.toFixed(2)} markiert.`);
      return;
    }

    await sendTelegram(`🚨 <b>WAL EXIT ERKANNT!</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nWhale hat kumuliert <b>${cumulativeSoldFractionPct.toFixed(1)}%</b> verkauft. Bot triggert Panik-Verkauf!`, {
      dedupeKey: `panic-exit:${whale.address}:${mint}`,
      cooldownMs: 60 * 60 * 1000,
      priority: true,
    });

    activeTrades[mint].panic = true;
    activeTrades[mint].panicMarkedAt = new Date().toISOString();
    activeTrades[mint].whaleSoldFraction = cumulativeSoldFraction;
    writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);
    console.log(`[PANIK] Token ${mint.slice(0,6)} für Notverkauf im Sell-Manager markiert!`);

  } catch (e: any) {
    console.error("Panik-Markierung fehlgeschlagen:", e);
    await sendTelegram(`❌ <b>PANIK-MARKIERUNG FEHLGESCHLAGEN</b>\nToken: ${mint.slice(0,6)}\nFehler: ${e.message}`, {
      dedupeKey: `panic-mark-failed:${mint}:${e.message}`,
      cooldownMs: 300_000,
      priority: true,
    });
  }
}

async function processTrackedWhaleLog(whale: WhaleRecord, signature: string) {
  if (!markSignatureProcessed(signature)) {
    return;
  }

  let wasHandled = false;
  try {
    const tx = await getParsedTransactionQueued(signature);
    if (!tx) {
      return;
    }

    wasHandled = true;
    const currentWhale = getTrackedWhale(whale.address);
    if (!currentWhale) {
      await removeTrackedWhaleSubscription(whale.address, 'whale deleted');
      return;
    }

    try {
      if (fs.existsSync(ACTIVE_TRADES_PATH) || fs.existsSync(PAPER_TRADES_PATH)) {
        const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
        const paperTrades = readPaperTrades();
        const trackedMints = new Set<string>();

        for (const [mint, tradeData] of Object.entries(activeTrades)) {
          if (typeof tradeData === 'string' && tradeData === currentWhale.address) {
            trackedMints.add(mint);
            continue;
          }

          if (tradeData && typeof tradeData === 'object' && tradeData.whale === currentWhale.address) {
            trackedMints.add(mint);
          }
        }

        for (const trade of Object.values(paperTrades)) {
          if (!trade || typeof trade !== 'object') {
            continue;
          }

          if (trade.whale === currentWhale.address && typeof trade.mint === 'string') {
            trackedMints.add(trade.mint);
          }
        }

        if (trackedMints.size > 0) {
          const tokenSold = tx.meta?.preTokenBalances?.find((pre) => {
            if (pre.owner !== currentWhale.address) return false;
            if (!trackedMints.has(pre.mint)) return false;

            const post = tx.meta?.postTokenBalances?.find((p) => p.mint === pre.mint && p.owner === currentWhale.address);
            const preAmt = Number(pre.uiTokenAmount.uiAmount);
            const postAmt = post ? Number(post.uiTokenAmount.uiAmount) : 0;
            return preAmt > postAmt && preAmt > 0;
          });

          if (tokenSold) {
            const post = tx.meta?.postTokenBalances?.find((entry) => entry.mint === tokenSold.mint && entry.owner === whale.address);
            const preAmt = Number(tokenSold.uiTokenAmount.uiAmount);
            const postAmt = post ? Number(post.uiTokenAmount.uiAmount) : 0;
            const soldFractionPct = preAmt > 0 ? Math.min(100, Math.max(0, ((preAmt - postAmt) / preAmt) * 100)) : 100;

            if (!markWhaleSignalProcessed(currentWhale.address, tokenSold.mint, 'sell')) {
              logSuppressedWhaleSignal(currentWhale.address, tokenSold.mint, 'sell');
              return;
            }

            appendWhaleActivity({
              whale: currentWhale.address,
              mint: tokenSold.mint,
              side: 'sell',
              detectedAt: new Date().toISOString(),
              signature,
              botMode: currentWhale.mode,
            });
            await executePanicSell(currentWhale, tokenSold.mint, soldFractionPct);
            return;
          }
        }
      }
    } catch (err) {
      console.log(`Fehler beim Panik-Check fuer ${currentWhale.address.slice(0,8)}.`);
    }

    const tokenChange = tx.meta?.postTokenBalances?.find((balance) =>
      balance.owner === currentWhale.address && balance.mint !== SOL_MINT,
    );

    if (!tokenChange) {
      return;
    }

    const preBalance = tx.meta?.preTokenBalances?.find((balance) => balance.owner === currentWhale.address && balance.mint === tokenChange.mint);
    const preAmt = preBalance ? Number(preBalance.uiTokenAmount.uiAmount) : 0;
    const postAmt = Number(tokenChange.uiTokenAmount.uiAmount);

    if (postAmt <= preAmt) {
      return;
    }

    if (!markWhaleSignalProcessed(currentWhale.address, tokenChange.mint, 'buy')) {
      logSuppressedWhaleSignal(currentWhale.address, tokenChange.mint, 'buy');
      return;
    }

    console.log(`[TREFFER] Wal ${currentWhale.address} hat Token gekauft: ${tokenChange.mint}`);
    appendWhaleActivity({
      whale: currentWhale.address,
      mint: tokenChange.mint,
      side: 'buy',
      detectedAt: new Date().toISOString(),
      signature,
      botMode: currentWhale.mode,
    });
    await logDecision(currentWhale, tokenChange.mint, tx, signature);
  } finally {
    finalizeSignatureProcessing(signature, wasHandled);
  }
}

async function refreshWhaleSubscriptions() {
  const whales = getWhales();
  const trackedAddresses = new Set(whales.map((whale) => whale.address));

  for (const [address, subscriptionId] of whaleLogSubscriptions.entries()) {
    if (trackedAddresses.has(address)) {
      continue;
    }

    await connection.removeOnLogsListener(subscriptionId);
    whaleLogSubscriptions.delete(address);
    console.log(`[TRACKER] Subscription fuer ${address.slice(0,8)} entfernt.`);
  }

  for (const whale of whales) {
    if (whaleLogSubscriptions.has(whale.address)) {
      continue;
    }

    const subscriptionId = connection.onLogs(new PublicKey(whale.address), async (logs) => {
      try {
        await processTrackedWhaleLog(whale, logs.signature);
      } catch (error) {
        console.error(`[TRACKER] Verarbeitung fuer ${whale.address.slice(0,8)} fehlgeschlagen:`, error);
      }
    }, 'confirmed');

    whaleLogSubscriptions.set(whale.address, subscriptionId);
    console.log(`[TRACKER] Subscription aktiv fuer ${whale.address.slice(0,8)} (${whale.mode}).`);
  }

  updateRuntimeStatus('tracker', {
    state: 'tracking',
    whaleCount: whales.length,
    activeSubscriptions: whaleLogSubscriptions.size,
    lastRefreshAt: new Date().toISOString(),
  });
}

// --- HAUPTSCHLEIFE ---
async function start() {
  console.log("🏹 Jäger-Bot ONLINE (Präzisions-Modus inkl. Panik-Schild & Kassenzettel)");
  logSizingConfiguration();
  updateRuntimeStatus('tracker', {
    state: 'starting',
    startedAt: new Date().toISOString(),
    activeSubscriptions: 0,
  });
  await refreshWhaleSubscriptions();
  setInterval(() => {
    refreshWhaleSubscriptions().catch((error) => {
      console.error('[TRACKER] Subscription-Refresh fehlgeschlagen:', error);
      updateRuntimeStatus('tracker', {
        state: 'error',
        lastErrorAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    });
  }, WHALE_SUBSCRIPTION_REFRESH_MS);
}

start().catch(console.error);
