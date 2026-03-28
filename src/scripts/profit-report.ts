import fs from 'fs';
import { sendTelegram } from "./telegram-notifier.js";

async function sendReport() {
  try {
    const perfData = JSON.parse(fs.readFileSync('./src/data/performance.json', 'utf-8'));
    const activeTrades = JSON.parse(fs.readFileSync('./src/data/active-trades.json', 'utf-8'));
    
    let totalTrades = 0;
    let wins = 0;
    
    for (const whale in perfData) {
      const history = perfData[whale];
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
