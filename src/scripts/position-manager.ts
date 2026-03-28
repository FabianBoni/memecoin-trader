import fs from 'fs';
import path from 'path';
import { Connection, PublicKey } from "@solana/web3.js";
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { logPaperWhalePerformance, logWhalePerformance } from "./performance-tracker.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { updateRuntimeStatus } from '../storage/runtime-status.js';
import { loadExecutionWallet } from "../wallet.js";
import { env } from "../config/env.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT_PCT_MONITOR || 50);
const STOP_LOSS = Number(process.env.STOP_LOSS_PCT_MONITOR || -20);
const TRAILING_ARM_PCT = env.TRAILING_ARM_PCT;
const TRAILING_DISTANCE_PCT = env.TRAILING_DISTANCE_PCT;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/active-trades.json');
const PAPER_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/paper-trades.json');

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

  const parsedTx = await params.connection.getParsedTransaction(entryTxid, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function reconcileWalletPositions(connection: Connection, walletPubKey: PublicKey) {
  const activeTrades = readActiveTrades();
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, { programId: TOKEN_PROGRAM_ID });
  let recoveredCount = 0;

  for (const accountInfo of tokenAccounts.value) {
    const parsedInfo = accountInfo.account.data.parsed.info;
    const mint = parsedInfo.mint as string | undefined;
    const tokenAmount = parsedInfo.tokenAmount;
    const balance = Number(tokenAmount?.uiAmount ?? 0);

    if (!mint || mint === SOL_MINT || !Number.isFinite(balance) || balance <= 0) {
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

async function logExitSignal(mint: string, balance: number, changePct: number, rawAmount: string, customReason?: string) {
  let isWin = changePct > 0;
  let realizedChangePct = changePct;
  let realizedExitPriceUsd: number | null = null;
  let realizedExitPriceSol: number | null = null;
  let priceSource = "market-snapshot";
  const reason = customReason || (isWin ? "TAKE PROFIT" : "STOP LOSS");
  const isPanicExit = reason === "PANIC EXIT";
  let emoji = isWin ? "💰" : "📉";

  try {
    let whaleAddress = null;
    let entryPriceUsd: number | null = null;
    let entryPriceSol: number | null = null;
    try {
      const activeTrades = readActiveTrades();
      const tradeData = activeTrades[mint];
      // Hybrid-Logik: Unterstützt altes String-Format und neues Objekt-Format
      whaleAddress = typeof tradeData === 'string' ? tradeData : tradeData.whale;
      if (typeof tradeData === 'object' && tradeData !== null) {
        if (tradeData.exiting) {
          console.log(`[MONITOR] ${mint.slice(0,6)} wird bereits verkauft. Doppelten Exit uebersprungen.`);
          return;
        }

        markTradeExitState(mint, {
          exiting: true,
          exitReason: reason,
          exitStartedAt: new Date().toISOString(),
        });
        entryPriceUsd = toFiniteNumber(tradeData.entryPrice);
        entryPriceSol = toFiniteNumber(tradeData.entryPriceSol);
      }
    } catch (err) {
      console.log("Konnte active-trades.json nicht lesen.");
    }

    await sendTelegram(`${emoji} <b>${reason} TRIGGER</b>\nToken: <code>${mint}</code>\nChange: ${changePct.toFixed(2)}%\nSelling: ${balance} Units`, {
      dedupeKey: `sell-trigger:${mint}:${reason}`,
      cooldownMs: 120_000,
      priority: true,
    });

    if (isPanicExit) {
      console.warn(`[PANIC SELL] START mint=${mint} balance=${balance} rawAmount=${rawAmount}`);
    }

    // 1. Verkauf ausführen
    const executionReceipt = await executeSellWithRetry({
      mint,
      rawAmount,
    });

    if (isPanicExit) {
      console.warn(`[PANIC SELL] TXID mint=${mint} txid=${executionReceipt?.txid ?? 'unknown'} source=${executionReceipt?.priceSource ?? 'unknown'}`);
    }

    realizedExitPriceUsd = toFiniteNumber(executionReceipt?.fillPriceUsd);
    realizedExitPriceSol = toFiniteNumber(executionReceipt?.fillPriceSol);
    priceSource = executionReceipt?.priceSource ?? priceSource;

    if (entryPriceUsd && realizedExitPriceUsd) {
      realizedChangePct = ((realizedExitPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
    } else if (entryPriceSol && realizedExitPriceSol) {
      realizedChangePct = ((realizedExitPriceSol - entryPriceSol) / entryPriceSol) * 100;
    }

    isWin = realizedChangePct > 0;
    emoji = isWin ? "💰" : "📉";

    // 2. Performance tracken (falls Wal bekannt)
    if (whaleAddress) {
      await logWhalePerformance(whaleAddress, isWin);
    }

    // 3. Aus aktiven Trades löschen & aufräumen (Immer!)
    try {
      const activeTrades = readActiveTrades();
        delete activeTrades[mint];
      writeActiveTrades(activeTrades);
        highWaterMarks.delete(mint);
        missingEntryWarnings.delete(mint);
    } catch (cleanupErr) {
        console.error("Fehler beim Aufräumen der aktiven Trades:", cleanupErr);
    }

    // 4. NEU: In Historie (Kassenbuch) eintragen
    try {
        const historyPath = './src/data/trade-history.json';
        let history = readJsonFileSync<any[]>(historyPath, []);
        history.unshift({
            mint: mint,
            whale: whaleAddress || "Unknown",
          pnl: realizedChangePct.toFixed(2),
            reason: reason,
          date: new Date().toLocaleString('de-DE'),
          entryPriceUsd: entryPriceUsd,
          exitPriceUsd: realizedExitPriceUsd,
          entryPriceSol: entryPriceSol,
          exitPriceSol: realizedExitPriceSol,
          exitTxid: executionReceipt?.txid,
          priceSource
        });
        // Maximal 50 Einträge behalten, damit das Dashboard schnell bleibt
        if (history.length > 50) history = history.slice(0, 50);
        writeJsonFileSync(historyPath, history);
    } catch (histErr) {
        console.error("Konnte Historie nicht speichern:", histErr);
    }

    await sendTelegram(`✅ <b>SUCCESSFULLY SOLD</b>\nToken: ${mint.slice(0,6)}...\nRealized PnL: ${realizedChangePct.toFixed(2)}%\nQuelle: ${priceSource}`, {
      dedupeKey: `sell-success:${mint}`,
      cooldownMs: 300_000,
      priority: true,
    });

    if (isPanicExit) {
      console.warn(`[PANIC SELL] CONFIRMED mint=${mint} txid=${executionReceipt?.txid ?? 'unknown'} realizedPnl=${realizedChangePct.toFixed(2)} source=${priceSource}`);
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

async function monitorPaperTrades() {
  const paperTrades = readPaperTrades();
  const paperTradeIds = Object.keys(paperTrades);

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
        await logPaperWhalePerformance(whale, false);
        delete paperTrades[tradeId];
        writePaperTrades(paperTrades);
        paperHighWaterMarks.delete(tradeId);
        console.log(`[PAPER] NO-PRICE EXIT ${mint.slice(0,6)} fuer ${whale.slice(0,8)} nach ${Math.round(tradeAgeMs / 60000)}m als Loss geschlossen.`);
      }
      continue;
    }

    const changePct = await getPaperTradeChangePct(trade, currentPrice);
    if (changePct === null) {
      continue;
    }

    const currentHigh = paperHighWaterMarks.get(tradeId) || 0;
    if (changePct > currentHigh) {
      paperHighWaterMarks.set(tradeId, changePct);
    }

    const maxSeen = paperHighWaterMarks.get(tradeId) || changePct;
    let dynamicStopLoss = STOP_LOSS;
    if (maxSeen >= TRAILING_ARM_PCT) {
      dynamicStopLoss = maxSeen - TRAILING_DISTANCE_PCT;
    }

    const shouldClose = trade.panic
      || changePct <= dynamicStopLoss
      || changePct >= 1000
      || (tradeAgeMs !== null && tradeAgeMs >= PAPER_TRADE_MAX_AGE_MS);
    if (!shouldClose) {
      continue;
    }

    const isWin = changePct > 0;
    await logPaperWhalePerformance(whale, isWin);
    delete paperTrades[tradeId];
    writePaperTrades(paperTrades);
    paperHighWaterMarks.delete(tradeId);
    const exitReason = trade.panic
      ? 'PANIC'
      : (tradeAgeMs !== null && tradeAgeMs >= PAPER_TRADE_MAX_AGE_MS)
        ? 'TIME EXIT'
        : 'EXIT';
    console.log(`[PAPER] ${exitReason} ${mint.slice(0,6)} fuer ${whale.slice(0,8)} mit ${changePct.toFixed(2)}% geschlossen.`);
  }
}

async function monitorPositions() {
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
    const connection = new Connection(RPC_URL);

    await reconcileWalletPositions(connection, walletPubKey);

    const activeTrades = readActiveTrades();
    const mints = Object.keys(activeTrades);

    if (mints.length === 0) return;

    for (const mint of mints) {
      try {
        const mintPubKey = new PublicKey(mint);
        const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, { mint: mintPubKey });

        let balance = 0;
        let rawAmount = "0";

        const tokenAmount = parsedTokenAccounts.value[0]?.account.data.parsed.info.tokenAmount;
        if (tokenAmount) {
          balance = tokenAmount.uiAmount;
          rawAmount = tokenAmount.amount;
        }

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
        let dynamicStopLoss = STOP_LOSS;

        if (maxSeen >= TRAILING_ARM_PCT) {
          dynamicStopLoss = maxSeen - TRAILING_DISTANCE_PCT;
        }

        console.log(`[MONITOR] ${mint.slice(0,6)} | PnL: ${changePct.toFixed(1)}% | Max: ${maxSeen.toFixed(1)}% | SL: ${dynamicStopLoss.toFixed(1)}%`);

        if (changePct <= dynamicStopLoss) {
          if (maxSeen >= TRAILING_ARM_PCT) {
            await logExitSignal(mint, balance, changePct, rawAmount, "TRAILING STOP (Gewinn gesichert!)");
          } else {
            await logExitSignal(mint, balance, changePct, rawAmount, "STOP LOSS");
          }
        } else if (changePct >= 1000) {
          await logExitSignal(mint, balance, changePct, rawAmount, "MOONSHOT SECURED");
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
