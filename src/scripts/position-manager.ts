import fs from 'fs';
import { Connection, PublicKey } from "@solana/web3.js";
import { sendTelegram } from "./telegram-notifier.js";
import { logWhalePerformance } from "./performance-tracker.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "26L5sdD2t88KZiQXSvQUtiY26XEM1DggdY5kv1wm8RNc";
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT_PCT_MONITOR || 50);
const STOP_LOSS = Number(process.env.STOP_LOSS_PCT_MONITOR || -20);

const highWaterMarks = new Map<string, number>();
const missingEntryWarnings = new Set<string>();

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function logExitSignal(mint: string, balance: number, changePct: number, rawAmount: string, customReason?: string) {
  let isWin = changePct > 0;
  let realizedChangePct = changePct;
  let realizedExitPriceUsd: number | null = null;
  let realizedExitPriceSol: number | null = null;
  let priceSource = "market-snapshot";
  const reason = customReason || (isWin ? "TAKE PROFIT" : "STOP LOSS");
  let emoji = isWin ? "💰" : "📉";

  try {
    let whaleAddress = null;
    let entryPriceUsd: number | null = null;
    let entryPriceSol: number | null = null;
    try {
      const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
      const tradeData = activeTrades[mint];
      // Hybrid-Logik: Unterstützt altes String-Format und neues Objekt-Format
      whaleAddress = typeof tradeData === 'string' ? tradeData : tradeData.whale;
      if (typeof tradeData === 'object' && tradeData !== null) {
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

    // 1. Verkauf ausführen
    const { executeJupiter } = await import("./execute-trade.js");
    const executionReceipt = await executeJupiter({
      planId: `SELL-${mint.slice(0,4)}`,
      tokenAddress: mint,
      executionMode: "jupiter",
      inputMint: mint,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: rawAmount,
      maxSlippageBps: 1500,
      dryRun: false
    } as any);

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
        const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
        delete activeTrades[mint];
        fs.writeFileSync('./src/data/active-trades.json', JSON.stringify(activeTrades, null, 2));
        highWaterMarks.delete(mint);
        missingEntryWarnings.delete(mint);
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
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    } catch (histErr) {
        console.error("Konnte Historie nicht speichern:", histErr);
    }

    await sendTelegram(`✅ <b>SUCCESSFULLY SOLD</b>\nToken: ${mint.slice(0,6)}...\nRealized PnL: ${realizedChangePct.toFixed(2)}%\nQuelle: ${priceSource}`, {
      dedupeKey: `sell-success:${mint}`,
      cooldownMs: 300_000,
      priority: true,
    });
  } catch (e: any) {
    console.error("❌ Auto-Sell failed:", e);
    await sendTelegram(`❌ <b>SELL FAILED</b>\nToken: ${mint.slice(0,6)}\nError: ${e.message}`, {
      dedupeKey: `sell-failed:${mint}:${e.message}`,
      cooldownMs: 300_000,
      priority: true,
    });
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

        const tokenAmount = parsedTokenAccounts.value[0]?.account.data.parsed.info.tokenAmount;
        if (tokenAmount) {
          balance = tokenAmount.uiAmount;
          rawAmount = tokenAmount.amount;
        }

        if (balance === 0) {
          delete activeTrades[mint];
          fs.writeFileSync('./src/data/active-trades.json', JSON.stringify(activeTrades, null, 2));
          highWaterMarks.delete(mint);
          missingEntryWarnings.delete(mint);
          continue;
        }

        const tradeData = activeTrades[mint];
        const hasStructuredTrade = typeof tradeData === 'object' && tradeData !== null;
        const baseline = hasStructuredTrade ? Number(tradeData.entryPrice) : Number.NaN;
        const hasValidEntryPrice = Number.isFinite(baseline) && baseline > 0;

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
