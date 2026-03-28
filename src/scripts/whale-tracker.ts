import { Connection, PublicKey } from "@solana/web3.js";
import fs from 'fs';
import { sendTelegram } from "./telegram-notifier.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const WS_URL = RPC_URL.replace("https://", "wss://");
const connection = new Connection(RPC_URL, { wsEndpoint: WS_URL });
const PERFORMANCE_PATH = './src/data/performance.json';

// DEINE WALLET ADRESSE HIER (wichtig für den Panik-Verkauf)
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "26L5sdD2t88KZiQXSvQUtiY26XEM1DggdY5kv1wm8RNc";

const getWhales = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync('./src/data/whales.json', 'utf-8'));
  } catch (e) {
    return [];
  }
};

function getPositionSizeProfile(whaleWallet: string) {
  const fullSize = Number(process.env.AUTO_BUY_AMOUNT_SOL || 0.05);
  const reducedSize = Number(process.env.AUTO_BUY_MID_AMOUNT_SOL || Math.min(fullSize, 0.1));
  const minimalSize = Number(process.env.AUTO_BUY_LOW_AMOUNT_SOL || Math.min(reducedSize, 0.02));

  try {
    if (!fs.existsSync(PERFORMANCE_PATH)) {
      return { positionSol: reducedSize, sampleSize: 0, winRate: null as number | null, tier: "reduced" };
    }

    const performance = JSON.parse(fs.readFileSync(PERFORMANCE_PATH, 'utf-8'));
    const history = Array.isArray(performance[whaleWallet])
      ? performance[whaleWallet].filter((value: unknown) => typeof value === 'boolean')
      : [];

    if (history.length === 0) {
      return { positionSol: reducedSize, sampleSize: 0, winRate: null as number | null, tier: "reduced" };
    }

    const wins = history.filter(Boolean).length;
    const winRate = (wins / history.length) * 100;

    if (winRate > 60) {
      return { positionSol: fullSize, sampleSize: history.length, winRate, tier: "full" };
    }

    if (winRate >= 30) {
      return { positionSol: reducedSize, sampleSize: history.length, winRate, tier: "reduced" };
    }

    return { positionSol: minimalSize, sampleSize: history.length, winRate, tier: "minimal" };
  } catch (error) {
    console.error("Konnte Wal-Performance nicht auswerten:", error);
    return { positionSol: reducedSize, sampleSize: 0, winRate: null as number | null, tier: "reduced" };
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
    ? "keine Historie"
    : `${positionProfile.winRate.toFixed(0)}% aus ${positionProfile.sampleSize} Trades`;

  await sendTelegram(`🚀 <b>WAL-SIGNAL!</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nBetrag: ${positionProfile.positionSol} SOL\nWin-Rate: ${winRateLabel}\nModus: ${positionProfile.tier}`);

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
      await sendTelegram(`⚠️ <b>ENTRY PRICE UNBEKANNT</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nTrade wurde ausgefuehrt, aber der Fill-Preis konnte nicht berechnet werden.`);
      return;
    }

    const fillSource = executionReceipt?.priceSource ?? "fallback-quote";
    const fillTxid = executionReceipt?.txid;
    const fillPriceSol = executionReceipt?.fillPriceSol;
    console.log(`[KASSENZETTEL] Kaufpreis fuer ${mint.slice(0,6)} gesichert: $${entryPrice} (${fillSource})`);

    const activeTradesPath = './src/data/active-trades.json';
    let activeTrades: any = {};
    if (fs.existsSync(activeTradesPath)) {
      activeTrades = JSON.parse(fs.readFileSync(activeTradesPath, 'utf-8'));
    }

    // NEU: Wir speichern jetzt das Hybrid-Objekt inkl. Preis und Wal-Adresse!
    activeTrades[mint] = {
      whale: whaleWallet,
      entryPrice,
      openedAt: new Date().toISOString(),
      positionSol: positionProfile.positionSol,
      whaleWinRateAtEntry: positionProfile.winRate,
      entryPriceSource: fillSource,
      entryTxid: fillTxid,
      entryPriceSol: fillPriceSol
    };

    fs.writeFileSync(activeTradesPath, JSON.stringify(activeTrades, null, 2));

  } catch (e: any) {
    await sendTelegram(`❌ <b>KAUF FEHLGESCHLAGEN</b>\nFehler: ${e.message}`);
  }
}

// --- VERKAUFS LOGIK (Panik-Exit / Wal-Verkauf) ---
async function executePanicSell(whaleWallet: string, mint: string) {
  console.log(`🚨 [PANIK] Wal ${whaleWallet.slice(0,6)} verkauft ${mint.slice(0,6)}! Notverkauf initiiert!`);
  await sendTelegram(`🚨 <b>WAL EXIT ERKANNT!</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nBot triggert sofortigen Panik-Verkauf!`);

  try {
    const activeTradesPath = './src/data/active-trades.json';
    if (!fs.existsSync(activeTradesPath)) return;
    
    const activeTrades = JSON.parse(fs.readFileSync(activeTradesPath, 'utf-8'));
    
    // Prüfen, ob wir den Token überhaupt noch haben
    if (!activeTrades[mint]) {
         await sendTelegram(`ℹ <b>INFO</b>\nToken: ${mint.slice(0,6)}...\nWal hat verkauft, aber wir waren schon vorher draußen!`);
         return;
    }

    activeTrades[mint].panic = true; // Markierung für den Manager
    activeTrades[mint].panicMarkedAt = new Date().toISOString();
    
    fs.writeFileSync(activeTradesPath, JSON.stringify(activeTrades, null, 2));
    
    console.log(`[PANIK] Token ${mint.slice(0,6)} für Notverkauf im Sell-Manager markiert!`);

  } catch (e: any) {
    console.error("Panik-Markierung fehlgeschlagen:", e);
    await sendTelegram(`❌ <b>PANIK-MARKIERUNG FEHLGESCHLAGEN</b>\nToken: ${mint.slice(0,6)}\nFehler: ${e.message}`);
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
        if (fs.existsSync('./src/data/active-trades.json')) {
          const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
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
