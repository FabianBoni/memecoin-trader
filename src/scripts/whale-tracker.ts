import { Connection, PublicKey } from "@solana/web3.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { updateRuntimeStatus } from '../storage/runtime-status.js';
import { env } from "../config/env.js";
import { loadExecutionWallet } from "../wallet.js";
import { normalizeWhales, type WhaleRecord } from '../storage/whales.js';
import { createAsyncLimiter, withRpcRetry } from '../solana/rpc-guard.js';

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const WS_URL = RPC_URL.replace("https://", "wss://");
const connection = new Connection(RPC_URL, { wsEndpoint: WS_URL });
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/active-trades.json');
const PAPER_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/paper-trades.json');
const PERFORMANCE_PATH = path.resolve(SCRIPT_DIR, '../data/performance.json');
const WHALES_PATH = path.resolve(SCRIPT_DIR, '../data/whales.json');
const WHALE_ACTIVITY_PATH = path.resolve(SCRIPT_DIR, '../data/whale-activity.json');
const WHALE_SUBSCRIPTION_REFRESH_MS = 60 * 1000;
const WHALE_SIGNAL_COOLDOWN_MS = 90 * 1000;
const TRACKER_PRICE_CACHE_TTL_MS = 15_000;
const TRACKER_PRICE_CONCURRENCY = 3;
const TRACKER_RPC_CONCURRENCY = 2;
const TRACKER_RPC_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

// Fallback auf die echte Execution-Wallet, falls WALLET_ADDRESS nicht gesetzt ist.
const WALLET_ADDRESS = process.env.WALLET_ADDRESS?.trim() || loadExecutionWallet().publicKey.toBase58();

function formatSolAmount(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'n/a';
  }

  return parsed >= 0.1 ? parsed.toFixed(3) : parsed.toFixed(4);
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
}) {
  const { executeJupiter } = await import('./execute-trade.js');
  const slippageLadder = getBuySlippageLadder(params.mint);
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < slippageLadder.length; attemptIndex += 1) {
    const maxSlippageBps = slippageLadder[attemptIndex];

    try {
      console.log(`[BUY] Versuch ${attemptIndex + 1}/${slippageLadder.length} fuer ${params.mint.slice(0,6)} mit ${maxSlippageBps} bps.`);
      const receipt = await executeJupiter({
        planId: `AUTO-${Date.now()}-A${attemptIndex + 1}`,
        tokenAddress: params.mint,
        finalPositionSol: params.positionSol,
        maxSlippageBps,
        executionMode: 'jupiter',
        dryRun: false,
      } as any);

      if (!receipt?.confirmed) {
        throw new Error(`Buy execution returned without on-chain confirmation for ${params.mint}.`);
      }

      return { receipt, maxSlippageBps, attempts: attemptIndex + 1 };
    } catch (error) {
      lastError = error;
      console.error(`[BUY] Versuch ${attemptIndex + 1}/${slippageLadder.length} fuer ${params.mint.slice(0,6)} fehlgeschlagen:`, error);

      const canRetry = attemptIndex < slippageLadder.length - 1;
      if (!canRetry) {
        break;
      }

      if (!isSlippageExceededError(error) && !shouldSuppressBuyFailureTelegram(error)) {
        break;
      }
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
  entryPriceSource: 'market-snapshot' | 'wallet-receipt' | 'wallet-receipt-sol-only';
  whaleWinRateAtEntry: number | null;
  entryPriceSol?: number | null;
  entryTxid?: string;
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
const tokenPriceCache = new Map<string, { fetchedAt: number; price: number | null }>();
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

  const entryPriceSol = Math.abs(nativeSolDelta) / tokenDeltaUi;
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
    () => connection.getParsedTransaction(signature, {
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

function markWhaleSignalProcessed(whaleAddress: string, mint: string, side: 'buy' | 'sell'): boolean {
  pruneRecentWhaleSignals();
  const signalKey = `${whaleAddress}:${mint}:${side}`;
  if (recentWhaleSignals.has(signalKey)) {
    return false;
  }

  recentWhaleSignals.set(signalKey, Date.now());
  return true;
}

function logSizingConfiguration() {
  const defaultSize = env.AUTO_BUY_AMOUNT_SOL;
  const eliteSize = Number(process.env.AUTO_BUY_ELITE_AMOUNT_SOL || defaultSize);
  const minimalSize = Number(process.env.AUTO_BUY_LOW_AMOUNT_SOL || defaultSize);

  console.log('[CONFIG] Whale sizing geladen:', {
    walletAddress: WALLET_ADDRESS,
    defaultSizeSol: defaultSize,
    eliteSizeSol: eliteSize,
    lowSizeSol: minimalSize,
    baseBuySlippageBps: env.MAX_JUPITER_BUY_SLIPPAGE_BPS,
    volatileBuySlippageBps: env.MAX_JUPITER_VOLATILE_BUY_SLIPPAGE_BPS,
    minimumSampleSize: 3,
  });
}

function getPositionSizeProfile(whaleWallet: string) {
  const defaultSize = env.AUTO_BUY_AMOUNT_SOL;
  const eliteSize = Number(process.env.AUTO_BUY_ELITE_AMOUNT_SOL || defaultSize);
  const minimalSize = Number(process.env.AUTO_BUY_LOW_AMOUNT_SOL || defaultSize);
  const minimumSampleSize = 3;

  try {
    if (!fs.existsSync(PERFORMANCE_PATH)) {
      return { positionSol: defaultSize, sampleSize: 0, winRate: null as number | null, tier: "test" };
    }

    const performance = readJsonFileSync<Record<string, boolean[]>>(PERFORMANCE_PATH, {});
    const history = Array.isArray(performance[whaleWallet])
      ? performance[whaleWallet].filter((value: unknown) => typeof value === 'boolean')
      : [];

    if (history.length < minimumSampleSize) {
      return { positionSol: defaultSize, sampleSize: history.length, winRate: null as number | null, tier: "test" };
    }

    const wins = history.filter(Boolean).length;
    const winRate = (wins / history.length) * 100;

    if (winRate > 60) {
      return { positionSol: eliteSize, sampleSize: history.length, winRate, tier: "elite" };
    }

    if (winRate < 40) {
      return { positionSol: minimalSize, sampleSize: history.length, winRate, tier: "caution" };
    }

    return { positionSol: defaultSize, sampleSize: history.length, winRate, tier: "standard" };
  } catch (error) {
    console.error("Konnte Wal-Performance nicht auswerten:", error);
    return { positionSol: defaultSize, sampleSize: 0, winRate: null as number | null, tier: "test" };
  }
}

async function fetchEntryPriceUsd(mint: string): Promise<number | null> {
  const cached = tokenPriceCache.get(mint);
  if (cached && (Date.now() - cached.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
    return cached.price;
  }

  return withPriceRequestSlot(async () => {
    const rechecked = tokenPriceCache.get(mint);
    if (rechecked && (Date.now() - rechecked.fetchedAt) < TRACKER_PRICE_CACHE_TTL_MS) {
      return rechecked.price;
    }

    try {
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
      const data = await res.json();
      const price = Number(data?.data?.[mint]?.price);
      const resolvedPrice = Number.isFinite(price) && price > 0 ? price : null;
      tokenPriceCache.set(mint, { fetchedAt: Date.now(), price: resolvedPrice });
      return resolvedPrice;
    } catch (error) {
      console.error(`Konnte Einstiegspreis fuer ${mint.slice(0,6)} nicht laden:`, error);
      tokenPriceCache.set(mint, { fetchedAt: Date.now(), price: null });
      return null;
    }
  });
}

// --- KAUF LOGIK (Mit Kassenzettel-System!) ---
async function openPaperTrade(
  whale: WhaleRecord,
  mint: string,
  positionProfile: ReturnType<typeof getPositionSizeProfile>,
  parsedTx?: Awaited<ReturnType<Connection['getParsedTransaction']>> | null,
  signature?: string,
) {
  const marketEntryPrice = await fetchEntryPriceUsd(mint);
  const receiptEntry = !marketEntryPrice
    ? await inferEntryPriceFromWhaleTransaction({ ...(parsedTx !== undefined ? { parsedTx } : {}), whaleAddress: whale.address, mint })
    : null;
  const entryPrice = marketEntryPrice ?? receiptEntry?.entryPrice ?? null;

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
    entryPriceSource: marketEntryPrice ? 'market-snapshot' : (receiptEntry?.source ?? 'market-snapshot'),
    whaleWinRateAtEntry: positionProfile.winRate,
    entryPriceSol: receiptEntry?.entryPriceSol ?? null,
  };
  if (signature) {
    paperTradeRecord.entryTxid = signature;
  }

  paperTrades[tradeId] = paperTradeRecord;
  writePaperTrades(paperTrades);
  console.log(`[PAPER] Neuer Schatten-Trade fuer ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)} gespeichert (${paperTradeRecord.entryPriceSource}).`);
}

async function logDecision(
  whale: WhaleRecord,
  mint: string,
  parsedTx?: Awaited<ReturnType<Connection['getParsedTransaction']>> | null,
  signature?: string,
) {
  const positionProfile = getPositionSizeProfile(whale.address);

  const winRateLabel = positionProfile.winRate === null
    ? `${positionProfile.sampleSize} Trades (Testphase)`
    : `${positionProfile.winRate.toFixed(0)}% aus ${positionProfile.sampleSize} Trades`;

  console.log(`[BUY] Entscheidung fuer ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)}... mode=${whale.mode} tier=${positionProfile.tier} size=${positionProfile.positionSol} sample=${positionProfile.sampleSize} winRate=${positionProfile.winRate ?? 'n/a'}`);

  if (whale.mode === 'paper') {
    await openPaperTrade(whale, mint, positionProfile, parsedTx, signature);
    return;
  }

  try {
    const { receipt: executionReceipt, maxSlippageBps, attempts } = await executeBuyWithRetry({
      mint,
      positionSol: positionProfile.positionSol,
    });

    const entryPrice = executionReceipt?.fillPriceUsd ?? await fetchEntryPriceUsd(mint);
    if (!executionReceipt?.confirmed) {
      throw new Error(`Trade for ${mint} was not confirmed on-chain and will not be persisted.`);
    }

    if (!entryPrice) {
      await sendTelegram(`⚠️ <b>ENTRY PRICE UNBEKANNT</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nTrade wurde ausgefuehrt, aber der Fill-Preis konnte nicht berechnet werden.`, {
        dedupeKey: `entry-price-unknown:${mint}`,
        cooldownMs: 6 * 60 * 60 * 1000,
      });
    }

    const fillSource = entryPrice
      ? (executionReceipt?.priceSource ?? "fallback-quote")
      : "unavailable";
    const fillTxid = executionReceipt?.txid;
    const fillPriceSol = executionReceipt?.fillPriceSol;
    if (entryPrice) {
      console.log(`[KASSENZETTEL] Kaufpreis fuer ${mint.slice(0,6)} gesichert: $${entryPrice} (${fillSource})`);
    } else {
      console.warn(`[KASSENZETTEL] Kaufpreis fuer ${mint.slice(0,6)} noch unbekannt. Trade wird trotzdem als aktiv gespeichert.`);
    }

    let activeTrades: any = readJsonFileSync(ACTIVE_TRADES_PATH, {});

    // NEU: Wir speichern jetzt das Hybrid-Objekt inkl. Preis und Wal-Adresse!
    activeTrades[mint] = {
      whale: whale.address,
      entryPrice: entryPrice ?? null,
      openedAt: new Date().toISOString(),
      balanceCheckGraceUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      positionSol: positionProfile.positionSol,
      whaleWinRateAtEntry: positionProfile.winRate,
      entryPriceSource: fillSource,
      entryTxid: fillTxid,
      entryPriceSol: fillPriceSol ?? null
    };

    writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);

    const persistedTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
    const activeCount = Object.keys(persistedTrades).length;
    const actualSizeSol = getExecutedBuySizeSol(executionReceipt, positionProfile.positionSol);

    await sendTelegram(`🚀 <b>WAL-SIGNAL GEKAUFT</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nGroesse: ${formatSolAmount(actualSizeSol)} SOL\nWin-Rate: ${winRateLabel}\nModus: ${positionProfile.tier}\nKaufversuche: <b>${attempts}</b>\nSlippage: <b>${maxSlippageBps} bps</b>\nAktive Positionen: <b>${activeCount}</b>\nQuelle: ${fillSource}${fillTxid ? `\nTx: <code>${fillTxid}</code>` : ''}`, {
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

// --- VERKAUFS LOGIK (Panik-Exit / Wal-Verkauf) ---
async function executePanicSell(whale: WhaleRecord, mint: string) {
  console.log(`🚨 [PANIK] Wal ${whale.address.slice(0,6)} verkauft ${mint.slice(0,6)}! Notverkauf initiiert!`);

  try {
    const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
    
    // Prüfen, ob wir den Token überhaupt noch haben
    if (!activeTrades[mint]) {
         const paperTrades = readPaperTrades();
         const paperTradeId = `${whale.address}:${mint}`;

         if (!paperTrades[paperTradeId]) {
           await sendTelegram(`ℹ <b>INFO</b>\nToken: ${mint.slice(0,6)}...\nWal hat verkauft, aber wir waren schon vorher draußen!`, {
             dedupeKey: `already-out:${mint}`,
             cooldownMs: 60 * 60 * 1000,
           });
           return;
         }

         paperTrades[paperTradeId].panic = true;
         paperTrades[paperTradeId].panicMarkedAt = new Date().toISOString();
         writePaperTrades(paperTrades);
         console.log(`[PAPER] Token ${mint.slice(0,6)} fuer Schatten-Exit markiert.`);
         return;
    }

    await sendTelegram(`🚨 <b>WAL EXIT ERKANNT!</b>\nWal: <code>${whale.address.slice(0,8)}</code>\nToken: <code>${mint}</code>\nBot triggert sofortigen Panik-Verkauf!`, {
      dedupeKey: `panic-exit:${whale.address}:${mint}`,
      cooldownMs: 60 * 60 * 1000,
      priority: true,
    });

    activeTrades[mint].panic = true; // Markierung für den Manager
    activeTrades[mint].panicMarkedAt = new Date().toISOString();
    
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

    try {
      if (fs.existsSync(ACTIVE_TRADES_PATH)) {
        const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
        const activeMints = Object.keys(activeTrades);

        if (activeMints.length > 0) {
          const tokenSold = tx.meta?.preTokenBalances?.find((pre) => {
            if (pre.owner !== whale.address) return false;
            if (!activeMints.includes(pre.mint)) return false;

            const post = tx.meta?.postTokenBalances?.find((p) => p.mint === pre.mint && p.owner === whale.address);
            const preAmt = Number(pre.uiTokenAmount.uiAmount);
            const postAmt = post ? Number(post.uiTokenAmount.uiAmount) : 0;
            return preAmt > postAmt && preAmt > 0;
          });

          if (tokenSold) {
            if (!markWhaleSignalProcessed(whale.address, tokenSold.mint, 'sell')) {
              console.log(`[TRACKER] Doppelte Sell-Erkennung fuer ${whale.address.slice(0,8)} ${tokenSold.mint.slice(0,6)} unterdrueckt.`);
              return;
            }

            appendWhaleActivity({
              whale: whale.address,
              mint: tokenSold.mint,
              side: 'sell',
              detectedAt: new Date().toISOString(),
              signature,
              botMode: whale.mode,
            });
            await executePanicSell(whale, tokenSold.mint);
            return;
          }
        }
      }
    } catch (err) {
      console.log(`Fehler beim Panik-Check fuer ${whale.address.slice(0,8)}.`);
    }

    const tokenChange = tx.meta?.postTokenBalances?.find((balance) =>
      balance.owner === whale.address && balance.mint !== SOL_MINT,
    );

    if (!tokenChange) {
      return;
    }

    const preBalance = tx.meta?.preTokenBalances?.find((balance) => balance.owner === whale.address && balance.mint === tokenChange.mint);
    const preAmt = preBalance ? Number(preBalance.uiTokenAmount.uiAmount) : 0;
    const postAmt = Number(tokenChange.uiTokenAmount.uiAmount);

    if (postAmt <= preAmt) {
      return;
    }

    if (!markWhaleSignalProcessed(whale.address, tokenChange.mint, 'buy')) {
      console.log(`[TRACKER] Doppelte Buy-Erkennung fuer ${whale.address.slice(0,8)} ${tokenChange.mint.slice(0,6)} unterdrueckt.`);
      return;
    }

    console.log(`[TREFFER] Wal ${whale.address} hat Token gekauft: ${tokenChange.mint}`);
    appendWhaleActivity({
      whale: whale.address,
      mint: tokenChange.mint,
      side: 'buy',
      detectedAt: new Date().toISOString(),
      signature,
      botMode: whale.mode,
    });
    await logDecision(whale, tokenChange.mint, tx, signature);
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
