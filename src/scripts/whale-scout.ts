import fs from 'fs';
import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { normalizeWhales } from '../storage/whales.js';
import { updateRuntimeStatus } from '../storage/runtime-status.js';

const RPC_URL = process.env.HELIUS_RPC_URL || "";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WHALE_FILE = path.resolve(SCRIPT_DIR, '../data/whales.json');
const FAST_SCOUT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SCOUT_INTERVAL_MS = 60 * 60 * 1000;
const FAST_SCOUT_WHALE_TARGET = 100;

// Hilfsfunktion für Pausen
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isLikelySolanaMintAddress(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length < 32 || trimmed.length > 44) {
    return false;
  }

  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

function getScoutIntervalMs(): number {
  const whaleCount = normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length;
  return whaleCount < FAST_SCOUT_WHALE_TARGET ? FAST_SCOUT_INTERVAL_MS : DEFAULT_SCOUT_INTERVAL_MS;
}

function logNextScoutRun() {
  const whaleCount = normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length;
  const intervalMs = whaleCount < FAST_SCOUT_WHALE_TARGET ? FAST_SCOUT_INTERVAL_MS : DEFAULT_SCOUT_INTERVAL_MS;
  const intervalMinutes = Math.round(intervalMs / 60_000);
  console.log(`[SCOUT] Naechster Lauf in ${intervalMinutes} Minuten (Whales: ${whaleCount}/${FAST_SCOUT_WHALE_TARGET}).`);
}

async function scout() {
  console.log("🔎 [SCOUT] Starte Blockchain-Suche (Anti-Spam Modus)...");
  updateRuntimeStatus('scout', {
    lastRunAt: new Date().toISOString(),
    state: 'running',
  });
  try {
    const connection = new Connection(RPC_URL);
    
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
    const tokens: any = await res.json();
    
    if (!tokens || tokens.length === 0) {
      updateRuntimeStatus('scout', {
        state: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastAddedCount: 0,
        whaleCount: normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length,
      });
      return;
    }

    const topToken = tokens[0]; 
    const mintAddress = topToken.tokenAddress;
    updateRuntimeStatus('scout', {
      lastToken: mintAddress,
    });

    if (topToken.chainId !== 'solana' || !isLikelySolanaMintAddress(mintAddress)) {
      console.log(`⏭ [SCOUT] Ueberspringe Nicht-Solana oder ungueltigen Token: ${String(mintAddress)}`);
      updateRuntimeStatus('scout', {
        state: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastAddedCount: 0,
        whaleCount: normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length,
      });
      return;
    }

    console.log(`🔥 Hype-Token erkannt: ${mintAddress}`);

    const mintPubKey = new PublicKey(mintAddress);
    // Wir holen nur die letzten 5 Käufer, das reicht für die Elite!
    const signatures = await connection.getSignaturesForAddress(mintPubKey, { limit: 5 });
    
    const currentWhales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
    let addedCount = 0;

    // Wir rufen die Transaktionen einzeln ab, mit Pause dazwischen!
    for (const sigObj of signatures) {
      try {
        const tx = await connection.getParsedTransaction(sigObj.signature, { 
            maxSupportedTransactionVersion: 0 
        });

        if (!tx || !tx.transaction) continue;
        
        const signer = tx.transaction.message.accountKeys.find((acc: any) => acc.signer);
        if (!signer) continue;
        
        const walletAddress = signer.pubkey.toBase58();

        if (!currentWhales.some((whale) => whale.address === walletAddress)) {
           currentWhales.push({
             address: walletAddress,
             mode: 'paper',
             discoveredAt: new Date().toISOString(),
             promotedAt: null,
             paperTrades: 0,
             liveTrades: 0,
           });
           addedCount++;
           
           console.log(`🎯 [SCOUT] Neuer Trader entdeckt: ${walletAddress}`);
           await sendTelegram(`🎯 <b>NEUER WAL GEFUNDEN</b>\nToken: <code>${mintAddress}</code>\nWallet: <code>${walletAddress}</code>\nStatus: <b>PAPER</b>`, {
             dedupeKey: `scout-new-whale:${mintAddress}:${walletAddress}`,
             cooldownMs: 24 * 60 * 60 * 1000,
           });
           
           if (addedCount >= 2) break;
        }
        
        // 1 Sekunde Pause, damit Helius uns nicht blockt!
        await sleep(1000);

      } catch (txError: any) {
         console.log(`Überspringe TX wegen Fehler: ${txError.message}`);
      }
    }

    if (addedCount > 0) {
        writeJsonFileSync(WHALE_FILE, currentWhales);
        console.log(`✅ [SCOUT] ${addedCount} neue Wale hinzugefügt!`);
    } else {
        console.log(`⏳ [SCOUT] Keine neuen Wale hinzugefügt.`);
    }

    updateRuntimeStatus('scout', {
      state: 'idle',
      lastSuccessAt: new Date().toISOString(),
      lastAddedCount: addedCount,
      whaleCount: currentWhales.length,
      lastToken: mintAddress,
    });

  } catch (e: any) {
    console.error("❌ Scout Fehler:", e.message);
    updateRuntimeStatus('scout', {
      state: 'error',
      lastErrorAt: new Date().toISOString(),
      lastError: e.message,
    });
  }
}

function scheduleNextScoutRun() {
  logNextScoutRun();
  const nextIntervalMs = getScoutIntervalMs();
  updateRuntimeStatus('scout', {
    nextRunInMs: nextIntervalMs,
    nextRunAt: new Date(Date.now() + nextIntervalMs).toISOString(),
  });
  setTimeout(runScoutLoop, nextIntervalMs);
}

async function runScoutLoop() {
  await scout();
  scheduleNextScoutRun();
}

runScoutLoop();
