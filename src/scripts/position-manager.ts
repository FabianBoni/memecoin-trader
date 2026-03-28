import fs from 'fs';
import path from 'path';
import { Connection, PublicKey } from "@solana/web3.js";
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { discardPaperWhalePerformance, logPaperWhalePerformance, logWhalePerformance } from "./performance-tracker.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { updateRuntimeStatus } from '../storage/runtime-status.js';
import { loadExecutionWallet } from "../wallet.js";
import { env } from "../config/env.js";
import { sleep, withRpcRetry } from '../solana/rpc-guard.js';

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT_PCT_MONITOR || 50);
const STOP_LOSS = Number(process.env.STOP_LOSS_PCT_MONITOR || -20);
const TAKE_PROFIT_SELL_FRACTION = env.DEFAULT_TAKE_PROFIT_SELL_FRACTION;
const TRAILING_ARM_PCT = env.TRAILING_ARM_PCT;
const TRAILING_DISTANCE_PCT = env.TRAILING_DISTANCE_PCT;
const RUNNER_STOP_FLOOR_PCT = env.RUNNER_STOP_FLOOR_PCT;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/active-trades.json');
const PAPER_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/paper-trades.json');
const TRADE_HISTORY_PATH = path.resolve(SCRIPT_DIR, '../data/trade-history.json');

const highWaterMarks = new Map<string, number>();
const missingEntryWarnings = new Set<string>();
const SELL_RETRY_ATTEMPTS = 5;
const SELL_RETRY_DELAY_MS = 2_500;
const NEW_POSITION_BALANCE_GRACE_MS = 5 * 60 * 1000;
const paperHighWaterMarks = new Map<string, number>();
const PRICE_CACHE_TTL_MS = 15_000;
const PAPER_TRADE_NO_PRICE_TIMEOUT_MS = 30 * 60 * 1000;
const PAPER_TRADE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const tokenPriceCache = new Map<string, { fetchedAt: number; price: number | null }>();
const solUsdPriceCache = { fetchedAt: 0, price: null as number | null };
const RPC_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const FRACTION_SCALE = 10_000n;
const connection = new Connection(RPC_URL);
let monitorRunInProgress = false;

type WalletTokenBalance = {
  balance: number;
  rawAmount: string;
};

function readActiveTrades(): Record<string, any> {
  return readJsonFileSync(ACTIVE_TRADES_PATH, {});
}

function writeActiveTrades(activeTrades: Record<string, any>) {
  writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);
}

function readPaperTrades(): Record<string, any> {
  return readJsonFileSync(PAPER_TRADES_PATH, {});
}

function writePaperTrades(paperTrades: Record<string, any>) {
  writeJsonFileSync(PAPER_TRADES_PATH, paperTrades);
}

function markTradeExitState(mint: string, patch: Record<string, unknown> | null): boolean {
  const activeTrades = readActiveTrades();
  const tradeData = activeTrades[mint];

  if (!tradeData || typeof tradeData !== 'object') {
    return false;
  }

  if (patch === null) {
    delete tradeData.exiting;
    delete tradeData.exitReason;
    delete tradeData.exitStartedAt;
    delete tradeData.lastExitError;
    delete tradeData.lastExitErrorAt;
  } else {
    Object.assign(tradeData, patch);
  }

  activeTrades[mint] = tradeData;
  writeActiveTrades(activeTrades);
  return true;
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampFraction(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

function hasTakeProfitTaken(tradeData: Record<string, any>): boolean {
  return tradeData.takeProfitTaken === true;
}

function getRealizedSoldFraction(tradeData: Record<string, any>): number {
  const directValue = toFiniteNumber(tradeData.realizedSoldFraction);
  if (directValue !== null) {
    return clampFraction(directValue);
  }

  const remaining = toFiniteNumber(tradeData.remainingPositionFraction);
  if (remaining !== null) {
    return clampFraction(1 - remaining);
  }

  return 0;
}

function getRemainingPositionFraction(tradeData: Record<string, any>): number {
  const remaining = toFiniteNumber(tradeData.remainingPositionFraction);
  if (remaining !== null) {
    return clampFraction(remaining, 1);
  }

  return clampFraction(1 - getRealizedSoldFraction(tradeData), 1);
}

function getRealizedPnlPct(tradeData: Record<string, any>): number {
  return toFiniteNumber(tradeData.realizedPnlPct) ?? 0;
}

function getCombinedPnlPct(tradeData: Record<string, any>, openLegPnlPct: number): number {
  return getRealizedPnlPct(tradeData) + (getRemainingPositionFraction(tradeData) * openLegPnlPct);
}

function getTradeHoldMinutes(tradeData: Record<string, any>): number {
  const ageMs = getTradeAgeMs(tradeData);
  if (ageMs === null) {
    return 0;
  }

  return ageMs / 60_000;
}

function getDynamicStopLoss(maxSeen: number, takeProfitTaken: boolean): number {
  let dynamicStopLoss = STOP_LOSS;

  if (maxSeen >= TRAILING_ARM_PCT) {
    dynamicStopLoss = maxSeen - TRAILING_DISTANCE_PCT;
  }

  if (takeProfitTaken) {
    dynamicStopLoss = Math.max(dynamicStopLoss, RUNNER_STOP_FLOOR_PCT);
  }

  return dynamicStopLoss;
}

function buildSellExecutionPlan(params: {
  rawAmount: string;
  balance: number;
  currentRemainingFraction: number;
  sellFractionCurrent: number;
}) {
  const desiredSellFraction = clampFraction(params.sellFractionCurrent, 1);
  if (desiredSellFraction <= 0) {
    return null;
  }

  const rawAmount = BigInt(params.rawAmount);
  if (rawAmount <= 0n) {
    return null;
  }

  let sellRawAmount = rawAmount;
  if (desiredSellFraction < 0.9999) {
    const scaledFraction = BigInt(Math.max(1, Math.min(Number(FRACTION_SCALE), Math.round(desiredSellFraction * Number(FRACTION_SCALE)))));
    sellRawAmount = (rawAmount * scaledFraction) / FRACTION_SCALE;
    if (sellRawAmount <= 0n) {
      sellRawAmount = 1n;
    }
  }

  if (sellRawAmount > rawAmount) {
    sellRawAmount = rawAmount;
  }

  const rawAsNumber = Number(rawAmount);
  const sellRawAsNumber = Number(sellRawAmount);
  const actualSellFractionCurrent = sellRawAmount >= rawAmount
    ? 1
    : (Number.isFinite(rawAsNumber) && rawAsNumber > 0 && Number.isFinite(sellRawAsNumber)
      ? Math.min(1, sellRawAsNumber / rawAsNumber)
      : desiredSellFraction);
  const soldOriginalFraction = Math.min(params.currentRemainingFraction, params.currentRemainingFraction * actualSellFractionCurrent);

  return {
    sellRawAmount: sellRawAmount.toString(),
    sellBalance: Number.isFinite(params.balance) ? params.balance * actualSellFractionCurrent : params.balance,
    actualSellFractionCurrent,
    soldOriginalFraction,
    remainingFractionAfterSell: Math.max(0, params.currentRemainingFraction - soldOriginalFraction),
  };
}

function appendTradeHistory(entry: Record<string, unknown>) {
  let history = readJsonFileSync<Record<string, unknown>[]>(TRADE_HISTORY_PATH, []);
  history.unshift(entry);
  if (history.length > 50) {
    history = history.slice(0, 50);
  }
  writeJsonFileSync(TRADE_HISTORY_PATH, history);
}

async function fetchSolUsdPrice(): Promise<number | null> {
  if (solUsdPriceCache.fetchedAt > 0 && (Date.now() - solUsdPriceCache.fetchedAt) < PRICE_CACHE_TTL_MS) {
    return solUsdPriceCache.price;
  }

  try {
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
    const data = await response.json();
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

async function tryBackfillEntryPrice(params: {
  connection: Connection;
  walletAddress: string;
  mint: string;
  tradeData: Record<string, any>;
  activeTrades: Record<string, any>;
}): Promise<boolean> {
  const existingEntryPrice = toFiniteNumber(params.tradeData.entryPrice);
  const existingEntryPriceSol = toFiniteNumber(params.tradeData.entryPriceSol);
  if (existingEntryPrice && existingEntryPrice > 0) {
    return false;
  }

  if (existingEntryPriceSol && existingEntryPriceSol > 0) {
    return false;
  }

  const entryTxid = typeof params.tradeData.entryTxid === 'string' ? params.tradeData.entryTxid : undefined;
  if (!entryTxid) {
    return false;
  }

  const parsedTx = await withRpcRetry(
    () => params.connection.getParsedTransaction(entryTxid, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    }),
    {
      delaysMs: RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`[MONITOR] RPC-Limit fuer Entry-TX ${entryTxid.slice(0,8)} erkannt. Retry ${attempt}/${RPC_RETRY_DELAYS_MS.length} in ${delayMs}ms.`);
      },
    },
  );

  if (!parsedTx) {
    return false;
  }

  const nativeSolDelta = getWalletNativeSolDelta(parsedTx, params.walletAddress);
  const tokenDeltaUi = getTokenDeltaUi(parsedTx, params.walletAddress, params.mint);

  if (nativeSolDelta === undefined || nativeSolDelta >= 0 || !tokenDeltaUi || tokenDeltaUi <= 0) {
    return false;
  }

  const fillPriceSol = Math.abs(nativeSolDelta) / tokenDeltaUi;
  const solUsdPrice = await fetchSolUsdPrice();
  const fillPriceUsd = solUsdPrice ? fillPriceSol * solUsdPrice : null;

  params.tradeData.entryPriceSol = fillPriceSol;
  params.tradeData.entryPrice = fillPriceUsd;
  params.tradeData.entryPriceSource = fillPriceUsd ? 'receipt-backfill' : 'receipt-backfill-sol-only';
  params.tradeData.entryBackfilledAt = new Date().toISOString();
  params.activeTrades[params.mint] = params.tradeData;
  writeActiveTrades(params.activeTrades);

  console.log(`[MONITOR] Entry-Preis fuer ${params.mint.slice(0,6)} nachtraeglich aus TX ${entryTxid.slice(0,8)}... ergaenzt.`);
  return true;
}

async function tryPromoteUsdEntryPriceFromSol(params: {
  mint: string;
  tradeData: Record<string, any>;
  activeTrades: Record<string, any>;
}): Promise<boolean> {
  const existingEntryPrice = toFiniteNumber(params.tradeData.entryPrice);
  if (existingEntryPrice && existingEntryPrice > 0) {
    return false;
  }

  const entryPriceSol = toFiniteNumber(params.tradeData.entryPriceSol);
  if (!entryPriceSol || entryPriceSol <= 0) {
    return false;
  }

  const solUsdPrice = await fetchSolUsdPrice();
  if (!solUsdPrice) {
    return false;
  }

  params.tradeData.entryPrice = entryPriceSol * solUsdPrice;
  params.tradeData.entryPriceSource = params.tradeData.entryPriceSource === 'receipt-backfill-sol-only'
    ? 'receipt-backfill'
    : (params.tradeData.entryPriceSource || 'derived-from-sol');
  params.tradeData.entryUsdPromotedAt = new Date().toISOString();
  params.activeTrades[params.mint] = params.tradeData;
  writeActiveTrades(params.activeTrades);

  console.log(`[MONITOR] USD-Einstieg fuer ${params.mint.slice(0,6)} aus entryPriceSol abgeleitet.`);
  return true;
}

function isWithinBalanceGracePeriod(tradeData: unknown): boolean {
  if (!tradeData || typeof tradeData !== 'object') {
    return false;
  }

  const graceUntil = (tradeData as { balanceCheckGraceUntil?: unknown }).balanceCheckGraceUntil;
  if (typeof graceUntil === 'string') {
    const graceUntilMs = Date.parse(graceUntil);
    if (Number.isFinite(graceUntilMs) && Date.now() < graceUntilMs) {
      return true;
    }
  }

  const openedAt = (tradeData as { openedAt?: unknown }).openedAt;
  if (typeof openedAt === 'string') {
    const openedAtMs = Date.parse(openedAt);
    if (Number.isFinite(openedAtMs) && Date.now() - openedAtMs < NEW_POSITION_BALANCE_GRACE_MS) {
      return true;
    }
  }

  return false;
}

async function executeSellWithRetry(params: {
  mint: string;
  rawAmount: string;
}) {
  const { executeJupiter } = await import("./execute-trade.js");
  let lastError: unknown;

  for (let attempt = 1; attempt <= SELL_RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        console.warn(`[SELL] Retry ${attempt}/${SELL_RETRY_ATTEMPTS} fuer ${params.mint.slice(0,6)} gestartet.`);
      }

      return await executeJupiter({
        planId: `SELL-${params.mint.slice(0,4)}-A${attempt}`,
        tokenAddress: params.mint,
        executionMode: "jupiter",
        inputMint: params.mint,
        outputMint: "So11111111111111111111111111111111111111112",
        amount: params.rawAmount,
        maxSlippageBps: 500,
        dryRun: false
      } as any);
    } catch (error) {
      lastError = error;
      console.error(`[SELL] Versuch ${attempt}/${SELL_RETRY_ATTEMPTS} fuer ${params.mint.slice(0,6)} fehlgeschlagen:`, error);

      if (attempt < SELL_RETRY_ATTEMPTS) {
        await sleep(SELL_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Sell execution failed after retries.");
}

function getTrackedWalletAddress(): string {
  if (process.env.WALLET_ADDRESS && process.env.WALLET_ADDRESS.trim().length > 0) {
    return process.env.WALLET_ADDRESS.trim();
  }

  return loadExecutionWallet().publicKey.toBase58();
}

function reconcileWalletPositions(walletBalances: Map<string, WalletTokenBalance>) {
  const activeTrades = readActiveTrades();
  let recoveredCount = 0;

  for (const [mint, walletBalance] of walletBalances.entries()) {
    if (!mint || mint === SOL_MINT || !Number.isFinite(walletBalance.balance) || walletBalance.balance <= 0) {
      continue;
    }

    if (activeTrades[mint]) {
      continue;
    }

    activeTrades[mint] = {
      whale: 'Recovered',
      entryPrice: null,
      entryPriceSol: null,
      positionSol: null,
      openedAt: new Date().toISOString(),
      entryPriceSource: 'wallet-recovered',
      recoveredFromWallet: true,
    };
    recoveredCount += 1;
  }

  if (recoveredCount > 0) {
    writeActiveTrades(activeTrades);
    console.log(`[MONITOR] ${recoveredCount} aktive Wallet-Positionen in active-trades gespiegelt.`);
  }
}

async function fetchWalletTokenBalances(walletPubKey: PublicKey): Promise<Map<string, WalletTokenBalance>> {
  const tokenAccounts = await withRpcRetry(
    () => connection.getParsedTokenAccountsByOwner(walletPubKey, { programId: TOKEN_PROGRAM_ID }),
    {
      delaysMs: RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`[MONITOR] RPC-Limit beim Wallet-Snapshot erkannt. Retry ${attempt}/${RPC_RETRY_DELAYS_MS.length} in ${delayMs}ms.`);
      },
    },
  );

  const balances = new Map<string, WalletTokenBalance>();

  for (const accountInfo of tokenAccounts.value) {
    const parsedInfo = accountInfo.account.data.parsed.info;
    const mint = parsedInfo.mint as string | undefined;
    const tokenAmount = parsedInfo.tokenAmount;
    const balance = Number(tokenAmount?.uiAmount ?? 0);
    const rawAmount = String(tokenAmount?.amount ?? '0');

    if (!mint || !Number.isFinite(balance) || balance <= 0) {
      continue;
    }

    const existing = balances.get(mint);
    if (!existing) {
      balances.set(mint, { balance, rawAmount });
      continue;
    }

    balances.set(mint, {
      balance: existing.balance + balance,
      rawAmount: (BigInt(existing.rawAmount) + BigInt(rawAmount)).toString(),
    });
  }

  return balances;
}

async function logExitSignal(
  mint: string,
  balance: number,
  changePct: number,
  rawAmount: string,
  customReason?: string,
  options?: {
    sellFractionCurrent?: number;
    finalExit?: boolean;
    currentHigh?: number;
  },
) {
  let isWin = changePct > 0;
  let realizedChangePct = changePct;
  let legChangePct = changePct;
  let realizedExitPriceUsd: number | null = null;
  let realizedExitPriceSol: number | null = null;
  let priceSource = "market-snapshot";
  const reason = customReason || (isWin ? "TAKE PROFIT" : "STOP LOSS");
  const isPanicExit = reason === "PANIC EXIT";
  const desiredSellFraction = clampFraction(options?.sellFractionCurrent, 1);
  let finalExit = options?.finalExit ?? desiredSellFraction >= 0.9999;
  let emoji = isWin ? "💰" : "📉";

  try {
    let whaleAddress: string | null = null;
    let entryPriceUsd: number | null = null;
    let entryPriceSol: number | null = null;
    let tradeDataSnapshot: Record<string, any> | null = null;
    let currentRemainingFraction = 1;
    let realizedSoFarPct = 0;
    let sellPlan = buildSellExecutionPlan({
      rawAmount,
      balance,
      currentRemainingFraction: 1,
      sellFractionCurrent: desiredSellFraction,
    });

    try {
      const activeTrades = readActiveTrades();
      const tradeData = activeTrades[mint];
      whaleAddress = typeof tradeData === 'string' ? tradeData : (tradeData?.whale ?? null);

      if (typeof tradeData === 'object' && tradeData !== null) {
        if (tradeData.exiting) {
          console.log(`[MONITOR] ${mint.slice(0,6)} wird bereits verkauft. Doppelten Exit uebersprungen.`);
          return;
        }

        tradeDataSnapshot = tradeData;
        currentRemainingFraction = getRemainingPositionFraction(tradeData);
        realizedSoFarPct = getRealizedPnlPct(tradeData);
        sellPlan = buildSellExecutionPlan({
          rawAmount,
          balance,
          currentRemainingFraction,
          sellFractionCurrent: desiredSellFraction,
        });

        if (!sellPlan) {
          console.warn(`[MONITOR] ${mint.slice(0,6)} konnte nicht verkauft werden: ungueltiger Teilverkauf.`);
          return;
        }

        if (sellPlan.remainingFractionAfterSell <= 0.0001) {
          finalExit = true;
        }

        markTradeExitState(mint, {
          exiting: true,
          exitReason: reason,
          exitStartedAt: new Date().toISOString(),
        });
        entryPriceUsd = toFiniteNumber(tradeData.entryPrice);
        entryPriceSol = toFiniteNumber(tradeData.entryPriceSol);
      }
    } catch {
      console.log("Konnte active-trades.json nicht lesen.");
    }

    if (!sellPlan) {
      return;
    }

    await sendTelegram(`${emoji} <b>${reason} TRIGGER</b>\nToken: <code>${mint}</code>\nChange: ${changePct.toFixed(2)}%\nSelling: ${sellPlan.sellBalance.toFixed(4)} Units${finalExit ? '' : `\nRest danach: ${(sellPlan.remainingFractionAfterSell * 100).toFixed(1)}%`}`, {
      dedupeKey: `sell-trigger:${mint}:${reason}:${finalExit ? 'full' : 'partial'}`,
      cooldownMs: 120_000,
      priority: true,
    });

    if (isPanicExit) {
      console.warn(`[PANIC SELL] START mint=${mint} balance=${sellPlan.sellBalance} rawAmount=${sellPlan.sellRawAmount}`);
    }

    const executionReceipt = await executeSellWithRetry({
      mint,
      rawAmount: sellPlan.sellRawAmount,
    });

    if (isPanicExit) {
      console.warn(`[PANIC SELL] TXID mint=${mint} txid=${executionReceipt?.txid ?? 'unknown'} source=${executionReceipt?.priceSource ?? 'unknown'}`);
    }

    realizedExitPriceUsd = toFiniteNumber(executionReceipt?.fillPriceUsd);
    realizedExitPriceSol = toFiniteNumber(executionReceipt?.fillPriceSol);
    priceSource = executionReceipt?.priceSource ?? priceSource;

    if (entryPriceUsd && realizedExitPriceUsd) {
      legChangePct = ((realizedExitPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
    } else if (entryPriceSol && realizedExitPriceSol) {
      legChangePct = ((realizedExitPriceSol - entryPriceSol) / entryPriceSol) * 100;
    }

    const combinedChangePct = realizedSoFarPct + (sellPlan.soldOriginalFraction * legChangePct);
    realizedChangePct = finalExit ? combinedChangePct : legChangePct;
    isWin = finalExit ? combinedChangePct > 0 : legChangePct > 0;
    emoji = isWin ? "💰" : "📉";

    if (finalExit && whaleAddress && whaleAddress !== 'Recovered') {
      const positiveExcursion = (options?.currentHigh ?? highWaterMarks.get(mint) ?? changePct) > 0
        || (tradeDataSnapshot ? hasTakeProfitTaken(tradeDataSnapshot) : false);
      await logWhalePerformance(whaleAddress, {
        mint,
        pnlPct: combinedChangePct,
        holdMinutes: tradeDataSnapshot ? getTradeHoldMinutes(tradeDataSnapshot) : 0,
        exitReason: reason,
        panicExit: isPanicExit,
        hadPositiveExcursion: positiveExcursion,
        roundTripCostBps: env.ESTIMATED_ROUND_TRIP_COST_BPS,
      });
    }

    try {
      const activeTrades = readActiveTrades();

      if (finalExit) {
        delete activeTrades[mint];
        writeActiveTrades(activeTrades);
        highWaterMarks.delete(mint);
        missingEntryWarnings.delete(mint);
      } else {
        const liveTrade = activeTrades[mint];
        if (liveTrade && typeof liveTrade === 'object') {
          liveTrade.remainingPositionFraction = sellPlan.remainingFractionAfterSell;
          liveTrade.realizedSoldFraction = clampFraction(getRealizedSoldFraction(liveTrade) + sellPlan.soldOriginalFraction);
          liveTrade.realizedPnlPct = getRealizedPnlPct(liveTrade) + (sellPlan.soldOriginalFraction * legChangePct);
          liveTrade.lastPartialExitAt = new Date().toISOString();
          liveTrade.lastPartialExitReason = reason;
          liveTrade.lastPartialExitTxid = executionReceipt?.txid;
          liveTrade.lastPartialExitPriceUsd = realizedExitPriceUsd;
          liveTrade.lastPartialExitPriceSol = realizedExitPriceSol;
          if (reason.startsWith('TAKE PROFIT')) {
            liveTrade.takeProfitTaken = true;
            liveTrade.takeProfitTakenAt = new Date().toISOString();
          }

          delete liveTrade.exiting;
          delete liveTrade.exitReason;
          delete liveTrade.exitStartedAt;
          delete liveTrade.lastExitError;
          delete liveTrade.lastExitErrorAt;
          activeTrades[mint] = liveTrade;
          writeActiveTrades(activeTrades);
        }
      }
    } catch (cleanupErr) {
      console.error("Fehler beim Aktualisieren der aktiven Trades:", cleanupErr);
    }

    try {
      appendTradeHistory({
        mint,
        whale: whaleAddress || "Unknown",
        pnl: realizedChangePct.toFixed(2),
        combinedPnlPct: combinedChangePct.toFixed(2),
        reason: finalExit ? reason : `${reason} (PARTIAL ${(sellPlan.soldOriginalFraction * 100).toFixed(1)}%)`,
        date: new Date().toLocaleString('de-DE'),
        partial: !finalExit,
        entryPriceUsd,
        exitPriceUsd: realizedExitPriceUsd,
        entryPriceSol,
        exitPriceSol: realizedExitPriceSol,
        soldFractionPct: Number((sellPlan.soldOriginalFraction * 100).toFixed(2)),
        remainingFractionPct: Number((sellPlan.remainingFractionAfterSell * 100).toFixed(2)),
        exitTxid: executionReceipt?.txid,
        priceSource,
      });
    } catch (histErr) {
      console.error("Konnte Historie nicht speichern:", histErr);
    }

    if (finalExit) {
      await sendTelegram(`✅ <b>SUCCESSFULLY SOLD</b>\nToken: ${mint.slice(0,6)}...\nRealized PnL: ${combinedChangePct.toFixed(2)}%\nQuelle: ${priceSource}`, {
        dedupeKey: `sell-success:${mint}`,
        cooldownMs: 300_000,
        priority: true,
      });
    } else {
      await sendTelegram(`✂️ <b>PARTIAL EXIT</b>\nToken: ${mint.slice(0,6)}...\nLeg PnL: ${legChangePct.toFixed(2)}%\nRealized so far: ${combinedChangePct.toFixed(2)}%\nRest offen: ${(sellPlan.remainingFractionAfterSell * 100).toFixed(1)}%\nQuelle: ${priceSource}`, {
        dedupeKey: `sell-partial:${mint}:${reason}`,
        cooldownMs: 180_000,
        priority: true,
      });
    }

    if (isPanicExit) {
      console.warn(`[PANIC SELL] CONFIRMED mint=${mint} txid=${executionReceipt?.txid ?? 'unknown'} realizedPnl=${(finalExit ? combinedChangePct : legChangePct).toFixed(2)} source=${priceSource}`);
    }
  } catch (e: any) {
    console.error("❌ Auto-Sell failed:", e);
    markTradeExitState(mint, {
      exiting: false,
      exitReason: undefined,
      exitStartedAt: undefined,
      lastExitError: e.message,
      lastExitErrorAt: new Date().toISOString(),
    });
    await sendTelegram(`❌ <b>SELL FAILED</b>\nToken: ${mint.slice(0,6)}\nError: ${e.message}`, {
      dedupeKey: `sell-failed:${mint}:${e.message}`,
      cooldownMs: 300_000,
      priority: true,
    });

    if (isPanicExit) {
      console.error(`[PANIC SELL] FAILED mint=${mint} error=${e.message}`);
    }
  }
}

async function getCurrentPrice(mint: string): Promise<number | null> {
  const cached = tokenPriceCache.get(mint);
  if (cached && (Date.now() - cached.fetchedAt) < PRICE_CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    const data = await res.json();
    if (data.data[mint] && data.data[mint].price) {
      const resolvedPrice = Number(data.data[mint].price);
      tokenPriceCache.set(mint, { fetchedAt: Date.now(), price: resolvedPrice });
      return resolvedPrice;
    }
    tokenPriceCache.set(mint, { fetchedAt: Date.now(), price: null });
    return null;
  } catch (e) {
    tokenPriceCache.set(mint, { fetchedAt: Date.now(), price: null });
    return null;
  }
}

async function getPaperTradeChangePct(trade: Record<string, any>, currentPriceUsd: number): Promise<number | null> {
  const entrySource = typeof trade.entryPriceSource === 'string' ? trade.entryPriceSource : 'market-snapshot';

  if (entrySource === 'wallet-receipt-sol-only') {
    const entryPriceSol = toFiniteNumber(trade.entryPriceSol) ?? toFiniteNumber(trade.entryPrice);
    if (!entryPriceSol || entryPriceSol <= 0) {
      return null;
    }

    const solUsdPrice = await fetchSolUsdPrice();
    if (!solUsdPrice || solUsdPrice <= 0) {
      return null;
    }

    const currentPriceSol = currentPriceUsd / solUsdPrice;
    return ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100;
  }

  const entryPriceUsd = toFiniteNumber(trade.entryPrice);
  if (!entryPriceUsd || entryPriceUsd <= 0) {
    return null;
  }

  return ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
}

function getTradeAgeMs(trade: Record<string, any>): number | null {
  if (typeof trade.openedAt !== 'string') {
    return null;
  }

  const openedAtMs = Date.parse(trade.openedAt);
  if (!Number.isFinite(openedAtMs)) {
    return null;
  }

  return Math.max(0, Date.now() - openedAtMs);
}

function getPendingWhaleTrimOriginalFraction(tradeData: Record<string, any>): number {
  const targetSoldFraction = clampFraction(
    toFiniteNumber(tradeData.whaleTrimFraction) ?? toFiniteNumber(tradeData.whaleSoldFraction) ?? 0,
    0,
  );
  const realizedSoldFraction = getRealizedSoldFraction(tradeData);
  const remainingPositionFraction = getRemainingPositionFraction(tradeData);
  return Math.min(remainingPositionFraction, Math.max(0, targetSoldFraction - realizedSoldFraction));
}

function applyPaperPartialExit(trade: Record<string, any>, soldOriginalFraction: number, changePct: number, reason: string) {
  if (soldOriginalFraction <= 0) {
    return false;
  }

  trade.remainingPositionFraction = Math.max(0, getRemainingPositionFraction(trade) - soldOriginalFraction);
  trade.realizedSoldFraction = clampFraction(getRealizedSoldFraction(trade) + soldOriginalFraction);
  trade.realizedPnlPct = getRealizedPnlPct(trade) + (soldOriginalFraction * changePct);
  trade.lastPartialExitAt = new Date().toISOString();
  trade.lastPartialExitReason = reason;

  if (reason.startsWith('TAKE PROFIT')) {
    trade.takeProfitTaken = true;
    trade.takeProfitTakenAt = new Date().toISOString();
  }

  return true;
}

async function monitorPaperTrades() {
  const paperTrades = readPaperTrades();
  const paperTradeIds = Object.keys(paperTrades);
  let paperTradesChanged = false;

  for (const tradeId of paperTradeIds) {
    const trade = paperTrades[tradeId];
    const mint = typeof trade?.mint === 'string' ? trade.mint : undefined;
    const whale = typeof trade?.whale === 'string' ? trade.whale : undefined;

    if (!mint || !whale) {
      continue;
    }

    const tradeAgeMs = getTradeAgeMs(trade);

    const currentPrice = await getCurrentPrice(mint);
    if (!currentPrice) {
      if (tradeAgeMs !== null && tradeAgeMs >= PAPER_TRADE_NO_PRICE_TIMEOUT_MS) {
        const lastObservedChangePct = toFiniteNumber(trade.lastObservedChangePct);
        const hadReliableObservation = trade.hasSeenPrice === true && lastObservedChangePct !== null;

        if (hadReliableObservation) {
          const maxSeen = paperHighWaterMarks.get(tradeId) || lastObservedChangePct;
          const combinedChangePct = getCombinedPnlPct(trade, lastObservedChangePct);
          await logPaperWhalePerformance(whale, {
            mint,
            pnlPct: combinedChangePct,
            holdMinutes: getTradeHoldMinutes(trade),
            exitReason: 'NO-PRICE EXIT',
            panicExit: trade.panic === true,
            hadPositiveExcursion: maxSeen > 0 || hasTakeProfitTaken(trade),
            roundTripCostBps: env.ESTIMATED_ROUND_TRIP_COST_BPS,
          });
          console.log(`[PAPER] NO-PRICE EXIT ${mint.slice(0,6)} fuer ${whale.slice(0,8)} mit letztem beobachteten ${lastObservedChangePct.toFixed(2)}% geschlossen.`);
        } else {
          discardPaperWhalePerformance(whale, 'no-price', mint);
          console.log(`[PAPER] NO-PRICE DISCARD ${mint.slice(0,6)} fuer ${whale.slice(0,8)} nach ${Math.round(tradeAgeMs / 60000)}m unbewertet verworfen.`);
        }

        delete paperTrades[tradeId];
        paperTradesChanged = true;
        paperHighWaterMarks.delete(tradeId);
      }
      continue;
    }

    const changePct = await getPaperTradeChangePct(trade, currentPrice);
    if (changePct === null) {
      continue;
    }

    const nextObservedAt = new Date().toISOString();
    if (trade.hasSeenPrice !== true
      || toFiniteNumber(trade.lastObservedPrice) !== currentPrice
      || toFiniteNumber(trade.lastObservedChangePct) !== changePct) {
      trade.hasSeenPrice = true;
      trade.lastObservedAt = nextObservedAt;
      trade.lastObservedPrice = currentPrice;
      trade.lastObservedChangePct = changePct;
      paperTrades[tradeId] = trade;
      paperTradesChanged = true;
    }

    const currentHigh = paperHighWaterMarks.get(tradeId) || 0;
    if (changePct > currentHigh) {
      paperHighWaterMarks.set(tradeId, changePct);
    }

    const maxSeen = paperHighWaterMarks.get(tradeId) || changePct;
    const takeProfitTaken = hasTakeProfitTaken(trade);
    const dynamicStopLoss = getDynamicStopLoss(maxSeen, takeProfitTaken);

    const shouldClose = trade.panic
      || changePct <= dynamicStopLoss
      || changePct >= 1000
      || (tradeAgeMs !== null && tradeAgeMs >= PAPER_TRADE_MAX_AGE_MS);
    if (shouldClose) {
      const combinedChangePct = getCombinedPnlPct(trade, changePct);
      const exitReason = trade.panic
        ? 'PANIC'
        : (tradeAgeMs !== null && tradeAgeMs >= PAPER_TRADE_MAX_AGE_MS)
          ? 'TIME EXIT'
          : changePct >= 1000
            ? 'MOONSHOT SECURED'
            : takeProfitTaken
              ? 'RUNNER STOP'
              : (maxSeen >= TRAILING_ARM_PCT ? 'TRAILING STOP' : 'STOP LOSS');

      await logPaperWhalePerformance(whale, {
        mint,
        pnlPct: combinedChangePct,
        holdMinutes: getTradeHoldMinutes(trade),
        exitReason,
        panicExit: trade.panic === true,
        hadPositiveExcursion: maxSeen > 0 || takeProfitTaken,
        roundTripCostBps: env.ESTIMATED_ROUND_TRIP_COST_BPS,
      });
      delete paperTrades[tradeId];
      paperTradesChanged = true;
      paperHighWaterMarks.delete(tradeId);
      console.log(`[PAPER] ${exitReason} ${mint.slice(0,6)} fuer ${whale.slice(0,8)} mit ${combinedChangePct.toFixed(2)}% geschlossen.`);
      continue;
    }

    if (!takeProfitTaken && changePct >= TAKE_PROFIT) {
      const soldOriginalFraction = getRemainingPositionFraction(trade) * TAKE_PROFIT_SELL_FRACTION;
      if (applyPaperPartialExit(trade, soldOriginalFraction, changePct, 'TAKE PROFIT')) {
        paperTrades[tradeId] = trade;
        paperTradesChanged = true;
        console.log(`[PAPER] TAKE PROFIT PARTIAL ${mint.slice(0,6)} fuer ${whale.slice(0,8)} bei ${changePct.toFixed(2)}%. Rest ${(getRemainingPositionFraction(trade) * 100).toFixed(1)}%.`);
        continue;
      }
    }

    const pendingWhaleTrimOriginalFraction = getPendingWhaleTrimOriginalFraction(trade);
    if (pendingWhaleTrimOriginalFraction > 0) {
      if (applyPaperPartialExit(trade, pendingWhaleTrimOriginalFraction, changePct, 'WHALE TRIM')) {
        paperTrades[tradeId] = trade;
        paperTradesChanged = true;
        console.log(`[PAPER] WHALE TRIM ${mint.slice(0,6)} fuer ${whale.slice(0,8)} gespiegelt. Rest ${(getRemainingPositionFraction(trade) * 100).toFixed(1)}%.`);
      }
    }
  }

  if (paperTradesChanged) {
    writePaperTrades(paperTrades);
  }
}

async function monitorPositions() {
  if (monitorRunInProgress) {
    console.warn('[MONITOR] Vorheriger Zyklus laeuft noch. Ueberlappenden Poll uebersprungen.');
    return;
  }

  monitorRunInProgress = true;
  try {
    await monitorPaperTrades();

    updateRuntimeStatus('positionManager', {
      state: 'monitoring',
      lastRunAt: new Date().toISOString(),
      openPaperTrades: Object.keys(readPaperTrades()).length,
      openLiveTrades: Object.keys(readActiveTrades()).length,
      priceCacheEntries: tokenPriceCache.size,
    });

    if (!fs.existsSync(ACTIVE_TRADES_PATH)) return;
    const walletAddress = getTrackedWalletAddress();
    const walletPubKey = new PublicKey(walletAddress);
    const walletBalances = await fetchWalletTokenBalances(walletPubKey);

    reconcileWalletPositions(walletBalances);

    const activeTrades = readActiveTrades();
    const mints = Object.keys(activeTrades);

    if (mints.length === 0) return;

    for (const mint of mints) {
      try {
        const walletPosition = walletBalances.get(mint);
        const balance = walletPosition?.balance ?? 0;
        const rawAmount = walletPosition?.rawAmount ?? '0';

        if (balance === 0) {
          if (isWithinBalanceGracePeriod(activeTrades[mint])) {
            console.warn(`[MONITOR] ${mint.slice(0,6)} noch ohne sichtbaren Token-Account. Loeschung waehrend Grace-Period uebersprungen.`);
            continue;
          }

          delete activeTrades[mint];
          writeActiveTrades(activeTrades);
          highWaterMarks.delete(mint);
          missingEntryWarnings.delete(mint);
          continue;
        }

        const tradeData = activeTrades[mint];
        const hasStructuredTrade = typeof tradeData === 'object' && tradeData !== null;

        if (hasStructuredTrade && tradeData.balanceCheckGraceUntil) {
          delete tradeData.balanceCheckGraceUntil;
          activeTrades[mint] = tradeData;
          writeActiveTrades(activeTrades);
        }

        if (hasStructuredTrade) {
          const backfilled = await tryBackfillEntryPrice({
            connection,
            walletAddress,
            mint,
            tradeData,
            activeTrades,
          });

          if (backfilled) {
            missingEntryWarnings.delete(mint);
          }

          const promotedUsdEntry = await tryPromoteUsdEntryPriceFromSol({
            mint,
            tradeData,
            activeTrades,
          });

          if (promotedUsdEntry) {
            missingEntryWarnings.delete(mint);
          }
        }

        const baseline = hasStructuredTrade ? Number(tradeData.entryPrice) : Number.NaN;
        const hasValidEntryPrice = Number.isFinite(baseline) && baseline > 0;

        if (hasStructuredTrade && tradeData.exiting) {
          continue;
        }

        if (hasStructuredTrade && tradeData.panic) {
          const currentPrice = await getCurrentPrice(mint);
          const panicChangePct = currentPrice && hasValidEntryPrice
            ? ((currentPrice - baseline) / baseline) * 100
            : 0;
          await logExitSignal(mint, balance, panicChangePct, rawAmount, "PANIC EXIT");
          continue;
        }

        if (!hasValidEntryPrice) {
          if (!missingEntryWarnings.has(mint)) {
            missingEntryWarnings.add(mint);
            console.warn(`[MONITOR] ${mint.slice(0,6)} uebersprungen: entryPrice fehlt oder ist ungueltig.`);
            await sendTelegram(`⚠️ <b>ENTRY PRICE FEHLT</b>\nToken: <code>${mint}</code>\nDer Trade wird nicht ueberwacht, bis ein gueltiger entryPrice gespeichert ist.`, {
              dedupeKey: `entry-price-missing:${mint}`,
              cooldownMs: 6 * 60 * 60 * 1000,
            });
          }
          continue;
        }

        const currentPrice = await getCurrentPrice(mint);
        if (!currentPrice) continue;

        missingEntryWarnings.delete(mint);

        const changePct = ((currentPrice - baseline) / baseline) * 100;
        const currentHigh = highWaterMarks.get(mint) || 0;
        if (changePct > currentHigh) {
          highWaterMarks.set(mint, changePct);
        }

        const maxSeen = highWaterMarks.get(mint) || changePct;
        const takeProfitTaken = hasStructuredTrade ? hasTakeProfitTaken(tradeData) : false;
        const dynamicStopLoss = getDynamicStopLoss(maxSeen, takeProfitTaken);

        console.log(`[MONITOR] ${mint.slice(0,6)} | PnL: ${changePct.toFixed(1)}% | Max: ${maxSeen.toFixed(1)}% | SL: ${dynamicStopLoss.toFixed(1)}%`);

        if (changePct <= dynamicStopLoss) {
          if (takeProfitTaken) {
            await logExitSignal(mint, balance, changePct, rawAmount, "RUNNER STOP", { currentHigh: maxSeen });
          } else if (maxSeen >= TRAILING_ARM_PCT) {
            await logExitSignal(mint, balance, changePct, rawAmount, "TRAILING STOP (Gewinn gesichert!)", { currentHigh: maxSeen });
          } else {
            await logExitSignal(mint, balance, changePct, rawAmount, "STOP LOSS", { currentHigh: maxSeen });
          }
        } else if (changePct >= 1000) {
          await logExitSignal(mint, balance, changePct, rawAmount, "MOONSHOT SECURED", { currentHigh: maxSeen });
        } else if (hasStructuredTrade && !takeProfitTaken && changePct >= TAKE_PROFIT) {
          await logExitSignal(mint, balance, changePct, rawAmount, "TAKE PROFIT", {
            sellFractionCurrent: TAKE_PROFIT_SELL_FRACTION,
            finalExit: false,
            currentHigh: maxSeen,
          });
        } else if (hasStructuredTrade) {
          const pendingWhaleTrimOriginalFraction = getPendingWhaleTrimOriginalFraction(tradeData);
          const remainingPositionFraction = getRemainingPositionFraction(tradeData);
          if (pendingWhaleTrimOriginalFraction > 0 && remainingPositionFraction > 0) {
            await logExitSignal(mint, balance, changePct, rawAmount, "WHALE TRIM", {
              sellFractionCurrent: Math.min(1, pendingWhaleTrimOriginalFraction / remainingPositionFraction),
              finalExit: false,
              currentHigh: maxSeen,
            });
          }
        }

      } catch (err: any) {
        console.error(`Fehler bei Token ${mint.slice(0,6)}:`, err.message);
      }
    }
  } catch (error: any) {
    console.error("Monitor Error:", error.message);
    updateRuntimeStatus('positionManager', {
      state: 'error',
      lastErrorAt: new Date().toISOString(),
      lastError: error.message,
      openPaperTrades: Object.keys(readPaperTrades()).length,
      openLiveTrades: Object.keys(readActiveTrades()).length,
    });
  } finally {
    monitorRunInProgress = false;
  }
}

setInterval(monitorPositions, 20000);
console.log("🛡 Position Manager (Hybrid Trailing Stop + History) ONLINE");
updateRuntimeStatus('positionManager', {
  state: 'starting',
  startedAt: new Date().toISOString(),
  openPaperTrades: Object.keys(readPaperTrades()).length,
  openLiveTrades: Object.keys(readActiveTrades()).length,
});
monitorPositions();
