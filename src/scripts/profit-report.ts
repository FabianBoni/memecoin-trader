import fs from 'fs';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync } from "../storage/json-file-sync.js";

async function sendReport() {
  try {
    const perfData = readJsonFileSync<Record<string, boolean[]>>('./src/data/performance.json', {});
    const activeTrades = readJsonFileSync<Record<string, unknown>>('./src/data/active-trades.json', {});
    
    let totalTrades = 0;
    let wins = 0;
    
    for (const whale in perfData) {
      const history = Array.isArray(perfData[whale]) ? perfData[whale] : [];
      totalTrades += history.length;
      wins += history.filter((v: boolean) => v === true).length;
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 0;
    const activeCount = Object.keys(activeTrades).length;

    const report = `
📊 <b>DEIN TRADING-REPORT</b>
------------------------
📈 Win-Rate: <b>${winRate}%</b>
✅ Abgeschlossene Trades: <b>${totalTrades}</b>
🎯 Aktive Positionen: <b>${activeCount}</b>
------------------------
🚀 <i>Bot läuft stabil im Präzisions-Modus.</i>
`;

    await sendTelegram(report);
    console.log("[REPORT] Statistik an Telegram gesendet.");
  } catch (e) {
    console.error("Report-Fehler:", e);
  }
}

// Bericht alle 24 Stunden senden
setInterval(sendReport, 1000 * 60 * 60 * 24);
// Ersten Bericht sofort senden
sendReport();
