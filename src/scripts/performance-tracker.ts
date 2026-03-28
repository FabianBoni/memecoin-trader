import path from 'path';
import { fileURLToPath } from 'url';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { normalizeWhales } from '../storage/whales.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PERF_FILE = path.resolve(SCRIPT_DIR, '../data/performance.json');
const WHALE_FILE = path.resolve(SCRIPT_DIR, '../data/whales.json');
const PAPER_PERF_FILE = path.resolve(SCRIPT_DIR, '../data/paper-performance.json');

function updateWhaleTradeCounts(address: string, field: 'paperTrades' | 'liveTrades', value: number) {
  const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
  const updatedWhales = whales.map((whale) => whale.address === address ? { ...whale, [field]: value } : whale);
  writeJsonFileSync(WHALE_FILE, updatedWhales);
}

export async function logWhalePerformance(whaleAddress: string, isWin: boolean) {
  try {
    const data = readJsonFileSync<Record<string, boolean[]>>(PERF_FILE, {});
    
    if (!data[whaleAddress]) data[whaleAddress] = [];
    
    // Ergebnis hinzufügen (true = Win, false = Loss)
    data[whaleAddress].push(isWin);
    
    // Nur die letzten 3 Trades behalten
    if (data[whaleAddress].length > 3) data[whaleAddress].shift();
    updateWhaleTradeCounts(whaleAddress, 'liveTrades', data[whaleAddress].length);

    // Check: 3 Verluste in Folge?
    const losses = data[whaleAddress].filter((v: boolean) => v === false).length;
    
    if (data[whaleAddress].length === 3 && losses === 3) {
      // Wal eliminieren
      const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
      const newWhales = whales.filter((w) => w.address !== whaleAddress);
      
      writeJsonFileSync(WHALE_FILE, newWhales);
      delete data[whaleAddress]; // Performance-Daten zurücksetzen
      
      await sendTelegram(`🚫 <b>WAL ELIMINIERT</b>\nAdresse: <code>${whaleAddress.slice(0,8)}...</code>\nGrund: 3 Verluste in Folge. Liste bereinigt!`);
      console.log(`[CLEANUP] Wal ${whaleAddress} entfernt.`);
    }

    writeJsonFileSync(PERF_FILE, data);
  } catch (e) {
    console.error("Performance Tracker Error:", e);
  }
}

export async function logPaperWhalePerformance(whaleAddress: string, isWin: boolean) {
  try {
    const data = readJsonFileSync<Record<string, boolean[]>>(PAPER_PERF_FILE, {});
    if (!data[whaleAddress]) data[whaleAddress] = [];

    data[whaleAddress].push(isWin);
    if (data[whaleAddress].length > 3) data[whaleAddress].shift();
    writeJsonFileSync(PAPER_PERF_FILE, data);

    updateWhaleTradeCounts(whaleAddress, 'paperTrades', data[whaleAddress].length);

    const whales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
    const whale = whales.find((item) => item.address === whaleAddress);
    if (!whale || whale.mode !== 'paper' || data[whaleAddress].length < 3) {
      return;
    }

    const wins = data[whaleAddress].filter(Boolean).length;
    const winRate = (wins / data[whaleAddress].length) * 100;
    if (winRate < 60) {
      return;
    }

    const promotedWhales = whales.map((item) => item.address === whaleAddress
      ? { ...item, mode: 'live' as const, promotedAt: new Date().toISOString() }
      : item);
    writeJsonFileSync(WHALE_FILE, promotedWhales);

    await sendTelegram(`🏆 <b>WAL PROMOTED</b>\nAdresse: <code>${whaleAddress.slice(0,8)}...</code>\nPaper Win-Rate: <b>${winRate.toFixed(0)}%</b>\nAb dem naechsten Trade wird live gehandelt.`, {
      dedupeKey: `whale-promoted:${whaleAddress}`,
      cooldownMs: 24 * 60 * 60 * 1000,
      priority: true,
    });
  } catch (e) {
    console.error('Paper Performance Tracker Error:', e);
  }
}
