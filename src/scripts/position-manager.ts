import fs from 'fs';
import { Connection, PublicKey } from "@solana/web3.js";
import { sendTelegram } from "./telegram-notifier.js";
import { logWhalePerformance } from "./performance-tracker.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { loadExecutionWallet } from "../wallet.js";

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT_PCT_MONITOR || 50);
const STOP_LOSS = Number(process.env.STOP_LOSS_PCT_MONITOR || -20);
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const highWaterMarks = new Map<string, number>();
const missingEntryWarnings = new Set<string>();

function readActiveTrades(): Record<string, any> {
  return readJsonFileSync('./src/data/active-trades.json', {});
}

function writeActiveTrades(activeTrades: Record<string, any>) {
  writeJsonFileSync('./src/data/active-trades.json', activeTrades);
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

    // 1. Verkauf ausführen
    const { executeJupiter } = await import("./execute-trade.js");
    const executionReceipt = await executeJupiter({
      planId: `SELL-${mint.slice(0,4)}`,
      tokenAddress: mint,
      executionMode: "jupiter",
      inputMint: mint,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: rawAmount,
      maxSlippageBps: 500,
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
          delete activeTrades[mint];
          writeActiveTrades(activeTrades);
          highWaterMarks.delete(mint);
          missingEntryWarnings.delete(mint);
          continue;
        }

        const tradeData = activeTrades[mint];
        const hasStructuredTrade = typeof tradeData === 'object' && tradeData !== null;
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
