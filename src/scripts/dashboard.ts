import express from 'express';
import fs from 'fs';
import path from 'path';
import basicAuth from 'express-basic-auth';

const app = express();

app.use(basicAuth({
    users: { 'admin': 'SuperSecret123!' }, 
    challenge: true
}));

const PORT = 3000;
const DATA_DIR = './src/data';

function safeReadJSON(filename: string, defaultData: any) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        if (!fs.existsSync(filePath)) return defaultData;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        return defaultData;
    }
}

app.get('/', (req, res) => {
    const whales = safeReadJSON('whales.json', []);
    const activeTrades = safeReadJSON('active-trades.json', {});
    const performance = safeReadJSON('performance.json', {});
    const history = safeReadJSON('trade-history.json', []); // NEU: Historie laden!

    let totalWins = 0;
    let totalLosses = 0;
    const whaleStats = Object.entries(performance).map(([address, data]: any) => {
        const wins = data.wins || 0;
        const losses = data.losses || 0;
        totalWins += wins;
        totalLosses += losses;
        const total = wins + losses;
        return { address, wins, losses, winRate: total > 0 ? Math.round((wins / total) * 100) : 0 };
    }).sort((a, b) => b.winRate - a.winRate);

    const totalTrades = totalWins + totalLosses;
    const globalWinRate = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;

    // Aktive Trades generieren
    let activeTradesHTML = '<p class="text-slate-500 text-center py-8 italic">Keine aktiven Trades.</p>';
    if (Object.keys(activeTrades).length > 0) {
        const rows = Object.entries(activeTrades).map(([mint, tData]: any) => {
            const whaleStr = (typeof tData === 'string' ? tData : tData.whale) || 'Unknown';
            return `
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td class="py-3 pl-2 font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${mint}" target="_blank">${mint.slice(0, 8)}...${mint.slice(-4)}</a></td>
                <td class="py-3 text-right pr-2 font-mono text-xs text-slate-400">${whaleStr.slice(0,6)}...</td>
            </tr>`;
        }).join('');
        activeTradesHTML = `<table class="w-full text-left"><tbody>${rows}</tbody></table>`;
    }

    // Wal Leaderboard generieren
    let whaleStatsHTML = '<p class="text-slate-500 text-center py-8 italic">Keine Daten.</p>';
    if (whaleStats.length > 0) {
        whaleStatsHTML = whaleStats.map(stat => `
            <div class="flex justify-between items-center py-3 border-b border-slate-800/50">
                <div class="font-mono text-sm text-slate-300">${stat.address.slice(0,8)}...</div>
                <div class="flex space-x-3 text-xs font-bold">
                    <span class="text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded">W: ${stat.wins}</span>
                    <span class="text-red-400 bg-red-400/10 px-2 py-1 rounded">L: ${stat.losses}</span>
                    <span class="${stat.winRate >= 50 ? 'text-blue-400' : 'text-slate-500'} w-10 text-right">${stat.winRate}%</span>
                </div>
            </div>`).join('');
    }

    // NEU: Trade Historie generieren
    let historyHTML = '<p class="text-slate-500 text-center py-8 italic">Noch keine abgeschlossenen Trades aufgezeichnet.</p>';
    if (history.length > 0) {
        const rows = history.map((trade: any) => {
            const isProfit = Number(trade.pnl) > 0;
            const pnlColor = isProfit ? 'text-emerald-400' : 'text-red-400';
            const bgBadge = isProfit ? 'bg-emerald-400/10' : 'bg-red-400/10';
            return `
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                <td class="py-3 pl-2 text-xs text-slate-400">${trade.date}</td>
                <td class="py-3 font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${trade.mint}" target="_blank">${trade.mint.slice(0, 6)}...</a></td>
                <td class="py-3 text-xs text-slate-400">${trade.reason}</td>
                <td class="py-3 text-right pr-2 font-bold ${pnlColor}"><span class="${bgBadge} px-2 py-1 rounded">${Number(trade.pnl) > 0 ? '+' : ''}${trade.pnl}%</span></td>
            </tr>`;
        }).join('');
        
        historyHTML = `
        <div class="overflow-x-auto max-h-[300px] custom-scrollbar">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700/50">
                        <th class="pb-3 pl-2">Datum</th>
                        <th class="pb-3">Token</th>
                        <th class="pb-3">Exit Grund</th>
                        <th class="pb-3 text-right pr-2">PnL %</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    // HTML Output
    const html = `
    <!DOCTYPE html>
    <html lang="de">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Whale Sniper Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: linear-gradient(135deg, #0f172a 0%, #020617 100%); color: #f8fafc; font-family: 'Inter', sans-serif; min-height: 100vh; }
            .glass-card { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 16px; padding: 24px; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5); }
            .custom-scrollbar::-webkit-scrollbar { width: 6px; }
            .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            .pulse { animation: pulse 2s infinite; } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
        </style>
        <script>setTimeout(() => { window.location.reload(); }, 10000);</script>
    </head>
    <body class="p-4 md:p-8 max-w-7xl mx-auto">
        
        <div class="flex justify-between items-center mb-10">
            <div><h1 class="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">🐋 Sniper Dashboard</h1></div>
            <div class="flex items-center space-x-2 bg-emerald-900/30 text-emerald-400 px-4 py-2 rounded-full border border-emerald-800/50"><div class="w-2.5 h-2.5 bg-emerald-500 rounded-full pulse"></div><span class="text-sm font-semibold">LIVE</span></div>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div class="glass-card border-t-4 border-t-blue-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Wale</h2><p class="text-3xl font-black">${whales.length}</p></div>
            <div class="glass-card border-t-4 border-t-yellow-400"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Positionen</h2><p class="text-3xl font-black text-yellow-400">${Object.keys(activeTrades).length}</p></div>
            <div class="glass-card border-t-4 border-t-purple-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Total Trades</h2><p class="text-3xl font-black">${totalTrades}</p></div>
            <div class="glass-card border-t-4 ${globalWinRate >= 50 ? 'border-t-emerald-500' : 'border-t-red-500'}"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Win-Rate</h2><p class="text-3xl font-black ${globalWinRate >= 50 ? 'text-emerald-400' : 'text-red-400'}">${globalWinRate}%</p></div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            <div class="glass-card"><h2 class="text-xl font-bold mb-4 flex items-center"><span class="bg-yellow-500/20 p-2 rounded-lg mr-3 text-yellow-500">🎯</span> Live Positionen</h2><div class="overflow-x-auto">${activeTradesHTML}</div></div>
            <div class="glass-card"><h2 class="text-xl font-bold mb-4 flex items-center"><span class="bg-purple-500/20 p-2 rounded-lg mr-3 text-purple-400">🏆</span> Wal Leaderboard</h2><div class="max-h-[300px] overflow-y-auto custom-scrollbar pr-2">${whaleStatsHTML}</div></div>
        </div>

        <div class="glass-card">
            <h2 class="text-xl font-bold mb-6 flex items-center">
                <span class="bg-blue-500/20 p-2 rounded-lg mr-3 text-blue-400">🧾</span> Letzte Verkäufe (Historie)
            </h2>
            ${historyHTML}
        </div>

    </body>
    </html>
    `;
    res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Dashboard läuft auf http://localhost:${PORT}`);
});
