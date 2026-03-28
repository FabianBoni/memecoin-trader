import fs from 'fs';
import { sendTelegram } from "./telegram-notifier.js";

const PERF_FILE = './src/data/performance.json';
const WHALE_FILE = './src/data/whales.json';

export async function logWhalePerformance(whaleAddress: string, isWin: boolean) {
  try {
    const data = JSON.parse(fs.readFileSync(PERF_FILE, 'utf-8'));
    
    if (!data[whaleAddress]) data[whaleAddress] = [];
    
    // Ergebnis hinzufügen (true = Win, false = Loss)
    data[whaleAddress].push(isWin);
    
    // Nur die letzten 3 Trades behalten
    if (data[whaleAddress].length > 3) data[whaleAddress].shift();

    // Check: 3 Verluste in Folge?
    const losses = data[whaleAddress].filter((v: boolean) => v === false).length;
    
    if (data[whaleAddress].length === 3 && losses === 3) {
      // Wal eliminieren
      const whales = JSON.parse(fs.readFileSync(WHALE_FILE, 'utf-8'));
      const newWhales = whales.filter((w: string) => w !== whaleAddress);
      
      fs.writeFileSync(WHALE_FILE, JSON.stringify(newWhales));
      delete data[whaleAddress]; // Performance-Daten zurücksetzen
      
      await sendTelegram(`🚫 <b>WAL ELIMINIERT</b>\nAdresse: <code>${whaleAddress.slice(0,8)}...</code>\nGrund: 3 Verluste in Folge. Liste bereinigt!`);
      console.log(`[CLEANUP] Wal ${whaleAddress} entfernt.`);
    }

    fs.writeFileSync(PERF_FILE, JSON.stringify(data));
  } catch (e) {
    console.error("Performance Tracker Error:", e);
  }
}
