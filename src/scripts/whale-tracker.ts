import { Connection, PublicKey } from "@solana/web3.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { env } from "../config/env.js";
import { loadExecutionWallet } from "../wallet.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const WS_URL = RPC_URL.replace("https://", "wss://");
const connection = new Connection(RPC_URL, { wsEndpoint: WS_URL });
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_TRADES_PATH = path.resolve(SCRIPT_DIR, '../data/active-trades.json');
const PERFORMANCE_PATH = path.resolve(SCRIPT_DIR, '../data/performance.json');
const WHALES_PATH = path.resolve(SCRIPT_DIR, '../data/whales.json');

// Fallback auf die echte Execution-Wallet, falls WALLET_ADDRESS nicht gesetzt ist.
const WALLET_ADDRESS = process.env.WALLET_ADDRESS?.trim() || loadExecutionWallet().publicKey.toBase58();

function formatSolAmount(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'n/a';
  }

  return parsed >= 0.1 ? parsed.toFixed(3) : parsed.toFixed(4);
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

const getWhales = (): string[] => {
  try {
    return readJsonFileSync(WHALES_PATH, []);
  } catch (e) {
    return [];
  }
};

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
async function logDecision(whaleWallet: string, mint: string) {
  const positionProfile = getPositionSizeProfile(whaleWallet);

  const winRateLabel = positionProfile.winRate === null
    ? `${positionProfile.sampleSize} Trades (Testphase)`
    : `${positionProfile.winRate.toFixed(0)}% aus ${positionProfile.sampleSize} Trades`;

  try {
    const { executeJupiter } = await import("./execute-trade.js");
    const executionReceipt = await executeJupiter({
      planId: `AUTO-${Date.now()}`,
      tokenAddress: mint,
      finalPositionSol: positionProfile.positionSol,
      executionMode: "jupiter",
      dryRun: false
    } as any);

    const entryPrice = executionReceipt?.fillPriceUsd ?? await fetchEntryPriceUsd(mint);
    if (!entryPrice) {
      await sendTelegram(`⚠️ <b>ENTRY PRICE UNBEKANNT</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nTrade wurde ausgefuehrt, aber der Fill-Preis konnte nicht berechnet werden.`, {
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
      whale: whaleWallet,
      entryPrice: entryPrice ?? null,
      openedAt: new Date().toISOString(),
      positionSol: positionProfile.positionSol,
      whaleWinRateAtEntry: positionProfile.winRate,
      entryPriceSource: fillSource,
      entryTxid: fillTxid,
      entryPriceSol: fillPriceSol ?? null
    };

    writeJsonFileSync(ACTIVE_TRADES_PATH, activeTrades);

    const persistedTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
    const activeCount = Object.keys(persistedTrades).length;
    const executedSol = Number(executionReceipt?.inputAmountUi);
    const actualSizeSol = Number.isFinite(executedSol) && executedSol > 0
      ? executedSol
      : positionProfile.positionSol;

    await sendTelegram(`🚀 <b>WAL-SIGNAL GEKAUFT</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nGroesse: ${formatSolAmount(actualSizeSol)} SOL\nWin-Rate: ${winRateLabel}\nModus: ${positionProfile.tier}\nAktive Positionen: <b>${activeCount}</b>\nQuelle: ${fillSource}${fillTxid ? `\nTx: <code>${fillTxid}</code>` : ''}`, {
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
async function executePanicSell(whaleWallet: string, mint: string) {
  console.log(`🚨 [PANIK] Wal ${whaleWallet.slice(0,6)} verkauft ${mint.slice(0,6)}! Notverkauf initiiert!`);
  await sendTelegram(`🚨 <b>WAL EXIT ERKANNT!</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nBot triggert sofortigen Panik-Verkauf!`, {
    dedupeKey: `panic-exit:${whaleWallet}:${mint}`,
    cooldownMs: 60 * 60 * 1000,
    priority: true,
  });

  try {
    if (!fs.existsSync(ACTIVE_TRADES_PATH)) return;
    
    const activeTrades = readJsonFileSync<Record<string, any>>(ACTIVE_TRADES_PATH, {});
    
    // Prüfen, ob wir den Token überhaupt noch haben
    if (!activeTrades[mint]) {
         await sendTelegram(`ℹ <b>INFO</b>\nToken: ${mint.slice(0,6)}...\nWal hat verkauft, aber wir waren schon vorher draußen!`, {
           dedupeKey: `already-out:${mint}`,
           cooldownMs: 60 * 60 * 1000,
         });
         return;
    }

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

  connection.onLogs("all", async (logs) => {
    const whales = getWhales();
    const foundWhale = whales.find(w => logs.logs.some(l => l.includes(w)));

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
              if(pre.owner !== foundWhale) return false;
              if(!activeMints.includes(pre.mint)) return false; // Token gehört zu unseren!

              const post = tx.meta?.postTokenBalances?.find(p => p.mint === pre.mint && p.owner === foundWhale);
              const preAmt = Number(pre.uiTokenAmount.uiAmount);
              const postAmt = post ? Number(post.uiTokenAmount.uiAmount) : 0;

              // Wenn Balance gesunken ist, hat er verkauft!
              return preAmt > postAmt && preAmt > 0;
            });

            if (tokenSold) {
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
        b.owner === foundWhale &&
        b.mint !== "So11111111111111111111111111111111111111112"
      );

      if (tokenChange) {
        // Wir prüfen zusätzlich, ob die Balance VORHER niedriger war (also ein echter Kauf)
        const preBalance = tx.meta?.preTokenBalances?.find(b => b.owner === foundWhale && b.mint === tokenChange.mint);
        const preAmt = preBalance ? Number(preBalance.uiTokenAmount.uiAmount) : 0;
        const postAmt = Number(tokenChange.uiTokenAmount.uiAmount);

        if (postAmt > preAmt) {
          console.log(`[TREFFER] Wal ${foundWhale} hat Token gekauft: ${tokenChange.mint}`);
          await logDecision(foundWhale, tokenChange.mint);
        }
      }
    }
  }, "confirmed");
}

start().catch(console.error);
