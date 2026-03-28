import fs from 'fs';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";

const PERF_FILE = './src/data/performance.json';
const WHALE_FILE = './src/data/whales.json';

export async function logWhalePerformance(whaleAddress: string, isWin: boolean) {
  try {
    const data = readJsonFileSync<Record<string, boolean[]>>(PERF_FILE, {});
    
    if (!data[whaleAddress]) data[whaleAddress] = [];
    
    // Ergebnis hinzufügen (true = Win, false = Loss)
    data[whaleAddress].push(isWin);
    
    // Nur die letzten 3 Trades behalten
    if (data[whaleAddress].length > 3) data[whaleAddress].shift();

    // Check: 3 Verluste in Folge?
    const losses = data[whaleAddress].filter((v: boolean) => v === false).length;
    
    if (data[whaleAddress].length === 3 && losses === 3) {
      // Wal eliminieren
      const whales = readJsonFileSync<string[]>(WHALE_FILE, []);
      const newWhales = whales.filter((w: string) => w !== whaleAddress);
      
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
