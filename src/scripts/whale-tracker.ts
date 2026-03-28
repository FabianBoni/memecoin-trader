import { Connection, PublicKey } from "@solana/web3.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { env } from "../config/env.js";
import { loadExecutionWallet } from "../wallet.js";
import { normalizeWhales, type WhaleRecord } from '../storage/whales.js';

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
  entryPriceSource: 'market-snapshot';
  whaleWinRateAtEntry: number | null;
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
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    const data = await res.json();
    const price = Number(data?.data?.[mint]?.price);

    if (Number.isFinite(price) && price > 0) {
      return price;
    }
  } catch (error) {
    console.error(`Konnte Einstiegspreis fuer ${mint.slice(0,6)} nicht laden:`, error);
  }

  return null;
}

// --- KAUF LOGIK (Mit Kassenzettel-System!) ---
async function openPaperTrade(whale: WhaleRecord, mint: string, positionProfile: ReturnType<typeof getPositionSizeProfile>) {
  const entryPrice = await fetchEntryPriceUsd(mint);
  if (!entryPrice) {
    console.warn(`[PAPER] ${mint.slice(0,6)} fuer ${whale.address.slice(0,8)} konnte ohne Einstiegspreis nicht als Paper-Trade angelegt werden.`);
    return;
  }

  const paperTrades = readPaperTrades();
  const tradeId = `${whale.address}:${mint}`;
  if (paperTrades[tradeId]) {
    return;
  }

  paperTrades[tradeId] = {
    id: tradeId,
    whale: whale.address,
    mint,
    entryPrice,
    openedAt: new Date().toISOString(),
    entryPriceSource: 'market-snapshot',
    whaleWinRateAtEntry: positionProfile.winRate,
  };
  writePaperTrades(paperTrades);
  console.log(`[PAPER] Neuer Schatten-Trade fuer ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)} gespeichert.`);
}

async function logDecision(whale: WhaleRecord, mint: string) {
  const positionProfile = getPositionSizeProfile(whale.address);

  const winRateLabel = positionProfile.winRate === null
    ? `${positionProfile.sampleSize} Trades (Testphase)`
    : `${positionProfile.winRate.toFixed(0)}% aus ${positionProfile.sampleSize} Trades`;

  console.log(`[BUY] Entscheidung fuer ${mint.slice(0,6)} von Wal ${whale.address.slice(0,8)}... mode=${whale.mode} tier=${positionProfile.tier} size=${positionProfile.positionSol} sample=${positionProfile.sampleSize} winRate=${positionProfile.winRate ?? 'n/a'}`);

  if (whale.mode === 'paper') {
    await openPaperTrade(whale, mint, positionProfile);
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

// --- HAUPTSCHLEIFE ---
async function start() {
  console.log("🏹 Jäger-Bot ONLINE (Präzisions-Modus inkl. Panik-Schild & Kassenzettel)");
  logSizingConfiguration();

  connection.onLogs("all", async (logs) => {
    const whales = getWhales();
    const foundWhale = whales.find((whale) => logs.logs.some((line) => line.includes(whale.address)));

    if (foundWhale) {
      const tx = await connection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      });

      if (!tx) return;

      // --- 1. PRÜFE AUF WAL-VERKAUF (PANIK) ---
      try {
        if (fs.existsSync(ACTIVE_TRADES_PATH)) {
          const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
          const activeMints = Object.keys(activeTrades);

          if (activeMints.length > 0) {
            const tokenSold = tx.meta?.preTokenBalances?.find(pre => {
              if(pre.owner !== foundWhale.address) return false;
              if(!activeMints.includes(pre.mint)) return false; // Token gehört zu unseren!

              const post = tx.meta?.postTokenBalances?.find(p => p.mint === pre.mint && p.owner === foundWhale.address);
              const preAmt = Number(pre.uiTokenAmount.uiAmount);
              const postAmt = post ? Number(post.uiTokenAmount.uiAmount) : 0;

              // Wenn Balance gesunken ist, hat er verkauft!
              return preAmt > postAmt && preAmt > 0;
            });

            if (tokenSold) {
              appendWhaleActivity({
                whale: foundWhale.address,
                mint: tokenSold.mint,
                side: 'sell',
                detectedAt: new Date().toISOString(),
                signature: logs.signature,
                botMode: foundWhale.mode,
              });
              await executePanicSell(foundWhale, tokenSold.mint);
              return; // Stop hier! Wir müssen nicht mehr prüfen, ob er gekauft hat.
            }
          }
        }
      } catch (err) {
        console.log("Fehler beim Panik-Check.");
      }

      // --- 2. PRÜFE AUF WAL-KAUF ---
      const tokenChange = tx.meta?.postTokenBalances?.find(b =>
        b.owner === foundWhale.address &&
        b.mint !== "So11111111111111111111111111111111111111112"
      );

      if (tokenChange) {
        // Wir prüfen zusätzlich, ob die Balance VORHER niedriger war (also ein echter Kauf)
        const preBalance = tx.meta?.preTokenBalances?.find(b => b.owner === foundWhale.address && b.mint === tokenChange.mint);
        const preAmt = preBalance ? Number(preBalance.uiTokenAmount.uiAmount) : 0;
        const postAmt = Number(tokenChange.uiTokenAmount.uiAmount);

        if (postAmt > preAmt) {
          console.log(`[TREFFER] Wal ${foundWhale.address} hat Token gekauft: ${tokenChange.mint}`);
          appendWhaleActivity({
            whale: foundWhale.address,
            mint: tokenChange.mint,
            side: 'buy',
            detectedAt: new Date().toISOString(),
            signature: logs.signature,
            botMode: foundWhale.mode,
          });
          await logDecision(foundWhale, tokenChange.mint);
        }
      }
    }
  }, "confirmed");
}

start().catch(console.error);
