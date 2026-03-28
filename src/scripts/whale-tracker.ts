import { Connection, PublicKey } from "@solana/web3.js";
import fs from 'fs';
import { sendTelegram } from "./telegram-notifier.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const WS_URL = RPC_URL.replace("https://", "wss://");
const connection = new Connection(RPC_URL, { wsEndpoint: WS_URL });

// DEINE WALLET ADRESSE HIER (wichtig für den Panik-Verkauf)
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "26L5sdD2t88KZiQXSvQUtiY26XEM1DggdY5kv1wm8RNc";

const getWhales = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync('./src/data/whales.json', 'utf-8'));
  } catch (e) {
    return [];
  }
};

// --- KAUF LOGIK (Mit Kassenzettel-System!) ---
async function logDecision(whaleWallet: string, mint: string) {
  const autoBuyAmount = Number(process.env.AUTO_BUY_AMOUNT_SOL || 0.05);
  await sendTelegram(`🚀 <b>WAL-SIGNAL!</b>\nWal: <code>${whaleWallet.slice(0,8)}</code>\nToken: <code>${mint}</code>\nBetrag: ${autoBuyAmount} SOL`);

  try {
    const { executeJupiter } = await import("./execute-trade.js");
    await executeJupiter({
      planId: `AUTO-${Date.now()}`,
      tokenAddress: mint,
      finalPositionSol: autoBuyAmount,
      executionMode: "jupiter",
      dryRun: false
    } as any);

    // NEU: Kassenzettel (Kaufpreis) von Jupiter holen
    let entryPrice = 0;
    try {
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
      const data = await res.json();
      if (data.data[mint] && data.data[mint].price) {
        entryPrice = Number(data.data[mint].price);
        console.log(`[KASSENZETTEL] Kaufpreis für ${mint.slice(0,6)} gesichert: $${entryPrice}`);
      }
    } catch (err) {
      console.log("Konnte Preis nicht sofort abrufen. Baseline wird später vom Manager gesetzt.");
    }

    const activeTradesPath = './src/data/active-trades.json';
    let activeTrades: any = {};
    if (fs.existsSync(activeTradesPath)) {
      activeTrades = JSON.parse(fs.readFileSync(activeTradesPath, 'utf-8'));
    }

    // NEU: Wir speichern jetzt das Hybrid-Objekt inkl. Preis und Wal-Adresse!
    activeTrades[mint] = {
      whale: whaleWallet,
      entryPrice: entryPrice
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

    // Wir setzen den Entry-Preis virtuell auf 1 Millionen, 
    // damit der Trailing-Stop im sell-manager SOFORT in Panik auslöst
    activeTrades[mint].entryPrice = 1000000;
    activeTrades[mint].panic = true; // Markierung für den Manager
    
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
