import fs from 'fs';
import { Connection, PublicKey } from "@solana/web3.js";
import { sendTelegram } from "./telegram-notifier.js";
import { logWhalePerformance } from "./performance-tracker.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "26L5sdD2t88KZiQXSvQUtiY26XEM1DggdY5kv1wm8RNc";
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT_PCT_MONITOR || 50);
const STOP_LOSS = Number(process.env.STOP_LOSS_PCT_MONITOR || -20);

const baselinePrices = new Map<string, number>();
const highWaterMarks = new Map<string, number>();

async function logExitSignal(mint: string, balance: number, changePct: number, rawAmount: string, customReason?: string) {
  const isWin = changePct > 0;
  const reason = customReason || (isWin ? "TAKE PROFIT" : "STOP LOSS");
  const emoji = isWin ? "💰" : "📉";

  try {
    let whaleAddress = null;
    try {
      const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
      const tradeData = activeTrades[mint];
      // Hybrid-Logik: Unterstützt altes String-Format und neues Objekt-Format
      whaleAddress = typeof tradeData === 'string' ? tradeData : tradeData.whale;
    } catch (err) {
      console.log("Konnte active-trades.json nicht lesen.");
    }

    await sendTelegram(`${emoji} <b>${reason} TRIGGER</b>\nToken: <code>${mint}</code>\nChange: ${changePct.toFixed(2)}%\nSelling: ${balance} Units`);

    // 1. Verkauf ausführen
    const { executeJupiter } = await import("./execute-trade.js");
    await executeJupiter({
      planId: `SELL-${mint.slice(0,4)}`,
      tokenAddress: mint,
      executionMode: "jupiter",
      inputMint: mint,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: rawAmount,
      maxSlippageBps: 1500,
      dryRun: false
    } as any);

    // 2. Performance tracken (falls Wal bekannt)
    if (whaleAddress) {
      await logWhalePerformance(whaleAddress, isWin);
    }

    // 3. Aus aktiven Trades löschen & aufräumen (Immer!)
    try {
        const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
        delete activeTrades[mint];
        fs.writeFileSync('./src/data/active-trades.json', JSON.stringify(activeTrades, null, 2));
        highWaterMarks.delete(mint);
        baselinePrices.delete(mint);
    } catch (cleanupErr) {
        console.error("Fehler beim Aufräumen der aktiven Trades:", cleanupErr);
    }

    // 4. NEU: In Historie (Kassenbuch) eintragen
    try {
        const historyPath = './src/data/trade-history.json';
        let history = [];
        if (fs.existsSync(historyPath)) {
            history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
        }
        history.unshift({
            mint: mint,
            whale: whaleAddress || "Unknown",
            pnl: changePct.toFixed(2),
            reason: reason,
            date: new Date().toLocaleString('de-DE')
        });
        // Maximal 50 Einträge behalten, damit das Dashboard schnell bleibt
        if (history.length > 50) history = history.slice(0, 50);
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    } catch (histErr) {
        console.error("Konnte Historie nicht speichern:", histErr);
    }

    await sendTelegram(`✅ <b>SUCCESSFULLY SOLD</b>\nToken: ${mint.slice(0,6)}...`);
  } catch (e: any) {
    console.error("❌ Auto-Sell failed:", e);
    await sendTelegram(`❌ <b>SELL FAILED</b>\nToken: ${mint.slice(0,6)}\nError: ${e.message}`);
  }
}

async function getCurrentPrice(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    const data = await res.json();
    if (data.data[mint] && data.data[mint].price) {
      return Number(data.data[mint].price);
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function monitorPositions() {
  try {
    if (!fs.existsSync('./src/data/active-trades.json')) return;
    const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
    const mints = Object.keys(activeTrades);

    if (mints.length === 0) return;

    const connection = new Connection(RPC_URL);
    const walletPubKey = new PublicKey(WALLET_ADDRESS);

    for (const mint of mints) {
      try {
        const mintPubKey = new PublicKey(mint);
        const parsedTokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, { mint: mintPubKey });

        let balance = 0;
        let rawAmount = "0";

        if (parsedTokenAccounts.value.length > 0) {
          balance = parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          rawAmount = parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
        }

        if (balance === 0) {
          delete activeTrades[mint];
          fs.writeFileSync('./src/data/active-trades.json', JSON.stringify(activeTrades, null, 2));
          continue;
        }

        const currentPrice = await getCurrentPrice(mint);
        if (!currentPrice) continue;

        let baseline = 0;
        const tradeData = activeTrades[mint];

        if (typeof tradeData === 'object' && tradeData.entryPrice) {
          baseline = tradeData.entryPrice;
        } else {
          if (!baselinePrices.has(mint)) {
            baselinePrices.set(mint, currentPrice);
            continue;
          }
          baseline = baselinePrices.get(mint)!;
        }

        const changePct = ((currentPrice - baseline) / baseline) * 100;
        const currentHigh = highWaterMarks.get(mint) || 0;
        if (changePct > currentHigh) {
          highWaterMarks.set(mint, changePct);
        }

        const maxSeen = highWaterMarks.get(mint) || changePct;
        let dynamicStopLoss = STOP_LOSS;

        if (maxSeen >= 50) {
          dynamicStopLoss = maxSeen - 30;
        }

        console.log(`[MONITOR] ${mint.slice(0,6)} | PnL: ${changePct.toFixed(1)}% | Max: ${maxSeen.toFixed(1)}% | SL: ${dynamicStopLoss.toFixed(1)}%`);

        if (changePct <= dynamicStopLoss) {
          if (maxSeen >= 50) {
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
  }
}

setInterval(monitorPositions, 20000);
console.log("🛡 Position Manager (Hybrid Trailing Stop + History) ONLINE");
monitorPositions();
