import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import basicAuth from 'express-basic-auth';
import { Connection, PublicKey } from '@solana/web3.js';
import { env, getHeliusRpcUrl, getReadOnlyRpcUrl } from '../config/env.js';
import { readJsonFileSync, writeJsonFileSync } from '../storage/json-file-sync.js';
import {
    buildWhaleModeSummary,
    clearWhaleStats,
    readWhaleStats,
    resetWhaleModeStats,
    type WhaleModeSummary,
    type WhaleStatsStore,
} from '../storage/whale-stats.js';
import { clearWhales, patchWhale, readWhales, writeWhales } from '../storage/whales.js';
import { readRuntimeStatus } from '../storage/runtime-status.js';

const app = express();

app.use(basicAuth({
    users: { 'admin': 'SuperSecret123!' }, 
    challenge: true
}));
app.use(express.urlencoded({ extended: false }));

const PORT = 3000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(SCRIPT_DIR, '../data');
const dashboardConnection = new Connection(getReadOnlyRpcUrl(getHeliusRpcUrl()), {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
});
const WHALE_DETAIL_CACHE_MS = 60 * 1000;
const WHALE_DETAIL_PAGE_LIMIT = 3;
const WHALE_DETAIL_SIGNATURES_PER_PAGE = 15;
const WHALE_DETAIL_PARSE_BATCH_SIZE = 5;
const PAPER_PERFORMANCE_FILE = path.join(DATA_DIR, 'paper-performance.json');
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trades.json');

const whaleTransactionCache = new Map<string, { fetchedAt: number; data: WhaleTransactionSummary[] }>();

type WhaleTokenDelta = {
    mint: string;
    delta: number;
};

type WhaleTransactionSummary = {
    signature: string;
    detectedAt: string;
    success: boolean;
    feeSol: number;
    solDelta: number | null;
    tokenDeltas: WhaleTokenDelta[];
};

function safeReadJSON(filename: string, defaultData: any) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        return readJsonFileSync(filePath, defaultData);
    } catch (e) {
        return defaultData;
    }
}

function writeDataJSON(filename: string, data: unknown) {
    writeJsonFileSync(path.join(DATA_DIR, filename), data);
}

function redirectWithMessage(res: express.Response, params: Record<string, string>) {
    const searchParams = new URLSearchParams(params);
    res.redirect(`/?${searchParams.toString()}`);
}

function createEmptySummary(): WhaleModeSummary {
    return {
        evaluatedTrades: 0,
        wins: 0,
        losses: 0,
        winRatePct: null,
        avgPnlPct: null,
        medianPnlPct: null,
        panicExitRatePct: null,
        avgHoldMinutes: null,
        positiveExcursionRatePct: null,
        avgRoundTripCostBps: null,
        noPriceDiscards: 0,
        streak: '',
    };
}

function getWhaleSummaries(store: WhaleStatsStore, address: string) {
    return {
        live: buildWhaleModeSummary(store, address, 'live'),
        paper: buildWhaleModeSummary(store, address, 'paper'),
    };
}

function isPromotionReady(summary: WhaleModeSummary): boolean {
    return summary.evaluatedTrades >= env.PAPER_PROMOTION_MIN_TRADES
        && (summary.winRatePct ?? 0) >= env.PAPER_PROMOTION_MIN_WIN_RATE_PCT
        && (summary.avgPnlPct ?? Number.NEGATIVE_INFINITY) >= env.PAPER_PROMOTION_MIN_AVG_PNL_PCT
        && (summary.medianPnlPct ?? Number.NEGATIVE_INFINITY) >= env.PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT;
}

function resetPaperStats(address?: string) {
    resetWhaleModeStats('paper', address);
}

function resetPaperWhale(address: string) {
    patchWhale(address, { paperTrades: 0 });

    const paperPerformance = readJsonFileSync<Record<string, boolean[]>>(PAPER_PERFORMANCE_FILE, {});
    delete paperPerformance[address];

    const paperTrades = readJsonFileSync<Record<string, any>>(PAPER_TRADES_FILE, {});
    const filteredPaperTrades = Object.fromEntries(
        Object.entries(paperTrades).filter(([, trade]) => trade?.whale !== address),
    );

    writeJsonFileSync(PAPER_PERFORMANCE_FILE, paperPerformance);
    writeJsonFileSync(PAPER_TRADES_FILE, filteredPaperTrades);
    resetPaperStats(address);
}

function resetAllPaperWhales() {
    const whales = readWhales();
    const updatedWhales = whales.map((whale) => whale.mode === 'paper' ? { ...whale, paperTrades: 0 } : whale);
    writeWhales(updatedWhales);
    writeDataJSON('paper-performance.json', {});
    writeDataJSON('paper-trades.json', {});
    resetPaperStats();
}

function resetAllWhales() {
    clearWhales();
    clearWhaleStats();
    writeDataJSON('performance.json', {});
    writeDataJSON('paper-performance.json', {});
    writeDataJSON('paper-trades.json', {});
    writeDataJSON('whale-activity.json', []);
    whaleTransactionCache.clear();
}

function formatUsd(value: unknown): string {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 'n/a';
    if (parsed >= 1) return `$${parsed.toFixed(4)}`;
    return `$${parsed.toExponential(4)}`;
}

function formatSolPrice(value: unknown): string {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 'n/a';
    return `${parsed.toExponential(4)} SOL`;
}

function formatEntrySourceLabel(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        return 'unbekannt';
    }

    switch (value) {
        case 'market-snapshot':
            return 'Jupiter';
        case 'dexscreener-snapshot':
            return 'Dexscreener';
        case 'wallet-receipt':
            return 'Wallet-Receipt';
        case 'wallet-receipt-sol-only':
            return 'SOL-only Receipt';
        default:
            return value;
    }
}

function formatPct(value: unknown): string {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 'n/a';
    return `${parsed > 0 ? '+' : ''}${parsed.toFixed(2)}%`;
}

function clampFraction(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(1, Math.max(0, parsed));
}

function formatFractionPct(value: unknown, fallback = 0): string {
    return `${(clampFraction(value, fallback) * 100).toFixed(1)}%`;
}

function getRealizedSoldFraction(trade: unknown): number {
    if (!trade || typeof trade !== 'object') {
        return 0;
    }

    const candidate = trade as Record<string, unknown>;
    if (Number.isFinite(Number(candidate.realizedSoldFraction))) {
        return clampFraction(candidate.realizedSoldFraction);
    }

    if (Number.isFinite(Number(candidate.remainingPositionFraction))) {
        return clampFraction(1 - Number(candidate.remainingPositionFraction));
    }

    return 0;
}

function getRemainingPositionFraction(trade: unknown): number {
    if (!trade || typeof trade !== 'object') {
        return 1;
    }

    const candidate = trade as Record<string, unknown>;
    if (Number.isFinite(Number(candidate.remainingPositionFraction))) {
        return clampFraction(candidate.remainingPositionFraction, 1);
    }

    return clampFraction(1 - getRealizedSoldFraction(trade), 1);
}

function getPendingWhaleTrimFraction(trade: unknown): number {
    if (!trade || typeof trade !== 'object') {
        return 0;
    }

    const candidate = trade as Record<string, unknown>;
    const targetTrimFraction = clampFraction(
        Number.isFinite(Number(candidate.whaleTrimFraction)) ? candidate.whaleTrimFraction : candidate.whaleSoldFraction,
        0,
    );
    return Math.max(0, targetTrimFraction - getRealizedSoldFraction(trade));
}

function getRealizedPnlPctValue(trade: unknown): number | null {
    if (!trade || typeof trade !== 'object') {
        return null;
    }

    const parsed = Number((trade as Record<string, unknown>).realizedPnlPct);
    return Number.isFinite(parsed) ? parsed : null;
}

function hasTakeProfitTakenFlag(trade: unknown): boolean {
    return !!trade && typeof trade === 'object' && (trade as Record<string, unknown>).takeProfitTaken === true;
}

function formatSignedNumber(value: number, digits = 4): string {
    if (!Number.isFinite(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatDateTime(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) return 'n/a';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return escapeHtml(value);
    return new Date(parsed).toLocaleString('de-DE');
}

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function whaleDetailsPath(address: string): string {
    return `/whale/${encodeURIComponent(address)}`;
}

function renderWhaleLink(address: string, label?: string): string {
    const safeLabel = escapeHtml(label ?? address);
    return `<a href="${whaleDetailsPath(address)}" class="text-cyan-300 hover:text-cyan-200 underline decoration-cyan-500/30 underline-offset-2">${safeLabel}</a>`;
}

function shortenAddress(value: string, start = 8, end = 4): string {
    return value.length <= start + end ? value : `${value.slice(0, start)}...${value.slice(-end)}`;
}

function getTokenBalanceMap(entries: any[] | undefined, owner: string): Map<string, number> {
    const balances = new Map<string, number>();
    for (const entry of entries ?? []) {
        if (entry?.owner !== owner || typeof entry?.mint !== 'string') {
            continue;
        }

        const amount = Number(entry?.uiTokenAmount?.uiAmount ?? 0);
        balances.set(entry.mint, (balances.get(entry.mint) ?? 0) + (Number.isFinite(amount) ? amount : 0));
    }

    return balances;
}

function summarizeWhaleTransaction(parsedTx: any, whaleAddress: string, signature: string, blockTime: number | null | undefined): WhaleTransactionSummary {
    const preTokenBalances = getTokenBalanceMap(parsedTx?.meta?.preTokenBalances, whaleAddress);
    const postTokenBalances = getTokenBalanceMap(parsedTx?.meta?.postTokenBalances, whaleAddress);
    const mints = new Set<string>([...preTokenBalances.keys(), ...postTokenBalances.keys()]);
    const tokenDeltas = Array.from(mints)
        .map((mint) => ({
            mint,
            delta: (postTokenBalances.get(mint) ?? 0) - (preTokenBalances.get(mint) ?? 0),
        }))
        .filter((entry) => Math.abs(entry.delta) > 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const accountKeys = parsedTx?.transaction?.message?.accountKeys ?? [];
    const walletIndex = accountKeys.findIndex((accountKey: any) => {
        if (typeof accountKey === 'string') {
            return accountKey === whaleAddress;
        }

        if (typeof accountKey?.pubkey === 'string') {
            return accountKey.pubkey === whaleAddress;
        }

        if (typeof accountKey?.pubkey?.toBase58 === 'function') {
            return accountKey.pubkey.toBase58() === whaleAddress;
        }

        return false;
    });

    const preBalance = walletIndex >= 0 ? parsedTx?.meta?.preBalances?.[walletIndex] : undefined;
    const postBalance = walletIndex >= 0 ? parsedTx?.meta?.postBalances?.[walletIndex] : undefined;
    const solDelta = preBalance !== undefined && postBalance !== undefined
        ? (postBalance - preBalance) / 1_000_000_000
        : null;

    return {
        signature,
        detectedAt: blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString(),
        success: !parsedTx?.meta?.err,
        feeSol: Number(parsedTx?.meta?.fee ?? 0) / 1_000_000_000,
        solDelta,
        tokenDeltas,
    };
}

async function fetchRecentWhaleTransactions(whaleAddress: string): Promise<WhaleTransactionSummary[]> {
    const cached = whaleTransactionCache.get(whaleAddress);
    if (cached && (Date.now() - cached.fetchedAt) < WHALE_DETAIL_CACHE_MS) {
        return cached.data;
    }

    const whalePubkey = new PublicKey(whaleAddress);
    const cutoffUnix = Math.floor((Date.now() - (12 * 60 * 60 * 1000)) / 1000);
    const signatures: Array<{ signature: string; blockTime: number | null }> = [];
    let before: string | undefined;

    for (let page = 0; page < WHALE_DETAIL_PAGE_LIMIT; page += 1) {
        const batch = await dashboardConnection.getSignaturesForAddress(whalePubkey, {
            limit: WHALE_DETAIL_SIGNATURES_PER_PAGE,
            ...(before ? { before } : {}),
        });

        if (batch.length === 0) {
            break;
        }

        let reachedOlderEntries = false;
        for (const entry of batch) {
            if (entry.blockTime && entry.blockTime < cutoffUnix) {
                reachedOlderEntries = true;
                break;
            }

            signatures.push({ signature: entry.signature, blockTime: entry.blockTime ?? null });
        }

        if (reachedOlderEntries) {
            break;
        }

        before = batch[batch.length - 1]?.signature;
    }

    const parsedTransactions: WhaleTransactionSummary[] = [];
    for (let index = 0; index < signatures.length; index += WHALE_DETAIL_PARSE_BATCH_SIZE) {
        const chunk = signatures.slice(index, index + WHALE_DETAIL_PARSE_BATCH_SIZE);
        const chunkResults = await Promise.all(
            chunk.map((entry) => dashboardConnection.getParsedTransaction(entry.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
            }).then((parsedTx) => parsedTx ? summarizeWhaleTransaction(parsedTx, whaleAddress, entry.signature, entry.blockTime) : null)),
        );

        parsedTransactions.push(...chunkResults.filter((entry): entry is WhaleTransactionSummary => entry !== null));
    }

    whaleTransactionCache.set(whaleAddress, { fetchedAt: Date.now(), data: parsedTransactions });
    return parsedTransactions;
}

app.post('/actions/reset-paper-whale', (req, res) => {
    const whaleAddress = String(req.body?.whaleAddress ?? '').trim();
    if (!whaleAddress) {
        redirectWithMessage(res, { error: 'Wal-Adresse fehlt fuer den Reset.' });
        return;
    }

    const whales = readWhales();
    const whale = whales.find((entry) => entry.address === whaleAddress);
    if (!whale) {
        redirectWithMessage(res, { error: `Wal ${whaleAddress.slice(0, 8)} wurde nicht gefunden.` });
        return;
    }

    resetPaperWhale(whaleAddress);
    redirectWithMessage(res, { message: `Paper-Daten fuer ${whaleAddress.slice(0, 8)} wurden zurueckgesetzt.` });
});

app.post('/actions/reset-paper-all', (_req, res) => {
    resetAllPaperWhales();
    redirectWithMessage(res, { message: 'Alle Paper-Bewertungen, Discards und offenen Paper-Trades wurden zurueckgesetzt.' });
});

app.post('/actions/reset-whales-all', (_req, res) => {
    resetAllWhales();
    redirectWithMessage(res, { message: 'Alle Wale, Whale-Stats, Whale-Activity sowie Paper-Performance wurden geloescht. Aktive Live-Trades bleiben unberuehrt.' });
});

app.get('/whale/:address', async (req, res) => {
    const whaleAddress = String(req.params.address ?? '').trim();
    const whales = readWhales();
    const whale = whales.find((entry) => entry.address === whaleAddress);
    const whaleStatsStore = readWhaleStats();
    const activity = Array.isArray(safeReadJSON('whale-activity.json', []))
        ? safeReadJSON('whale-activity.json', []).filter((entry: any) => entry?.whale === whaleAddress).slice(0, 20)
        : [];

    if (!whaleAddress) {
        res.status(400).send('Whale address missing');
        return;
    }

    try {
        const txRows = await fetchRecentWhaleTransactions(whaleAddress);
        const { live: liveSummary, paper: paperSummary } = getWhaleSummaries(whaleStatsStore, whaleAddress);

        const txTable = txRows.length === 0
            ? '<p class="text-slate-500 text-center py-8 italic">Keine Transaktionen in den letzten 12 Stunden gefunden.</p>'
            : `
            <div class="overflow-x-auto custom-scrollbar">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700/50">
                            <th class="pb-3 pl-2">Zeit</th>
                            <th class="pb-3">Status</th>
                            <th class="pb-3">SOL Δ</th>
                            <th class="pb-3">Fee</th>
                            <th class="pb-3">Token Changes</th>
                            <th class="pb-3">Tx</th>
                        </tr>
                    </thead>
                    <tbody>${txRows.map((tx) => {
                        const tokenChanges = tx.tokenDeltas.length > 0
                            ? tx.tokenDeltas.slice(0, 4).map((entry) => {
                                const badgeColor = entry.delta > 0 ? 'text-emerald-300 bg-emerald-500/10' : 'text-red-300 bg-red-500/10';
                                return `<span class="${badgeColor} px-2 py-1 rounded mr-2 inline-block mb-1">${formatSignedNumber(entry.delta, 2)} ${escapeHtml(shortenAddress(entry.mint, 6, 4))}</span>`;
                            }).join('')
                            : '<span class="text-slate-500">keine Token-Änderung</span>';
                        const statusBadge = tx.success
                            ? '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">ok</span>'
                            : '<span class="text-red-300 bg-red-500/10 px-2 py-1 rounded">failed</span>';
                        const solDelta = tx.solDelta === null ? 'n/a' : `${formatSignedNumber(tx.solDelta)} SOL`;
                        return `
                        <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors align-top">
                            <td class="py-3 pl-2 text-xs text-slate-400">${formatDateTime(tx.detectedAt)}</td>
                            <td class="py-3 text-xs">${statusBadge}</td>
                            <td class="py-3 text-xs text-slate-300">${solDelta}</td>
                            <td class="py-3 text-xs text-slate-400">${tx.feeSol.toFixed(6)} SOL</td>
                            <td class="py-3 text-xs text-slate-300">${tokenChanges}</td>
                            <td class="py-3 text-xs text-slate-400"><a href="https://solscan.io/tx/${tx.signature}" target="_blank">${escapeHtml(shortenAddress(tx.signature, 8, 4))}</a></td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>
            </div>`;

        const activityHtml = activity.length === 0
            ? '<p class="text-slate-500 text-center py-6 italic">Keine lokal erkannten Bot-Events für diesen Wal.</p>'
            : activity.map((entry: any) => {
                const sideBadge = entry?.side === 'buy'
                    ? '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">buy</span>'
                    : '<span class="text-red-300 bg-red-500/10 px-2 py-1 rounded">sell</span>';
                return `
                <div class="flex justify-between items-center py-3 border-b border-slate-800/50">
                    <div>
                        <div class="font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${entry.mint}" target="_blank">${escapeHtml(shortenAddress(entry.mint, 8, 4))}</a></div>
                        <div class="text-[11px] text-slate-500">${formatDateTime(entry.detectedAt)}</div>
                    </div>
                    <div class="text-right">
                        <div class="mb-1 text-xs">${sideBadge}</div>
                        <div class="text-[11px] text-slate-500">${escapeHtml(entry.botMode ?? 'unknown')}</div>
                    </div>
                </div>`;
            }).join('');

        const html = `
        <!DOCTYPE html>
        <html lang="de">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Wal-Details</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                body { background: linear-gradient(135deg, #0f172a 0%, #020617 100%); color: #f8fafc; font-family: 'Inter', sans-serif; min-height: 100vh; }
                .glass-card { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 16px; padding: 24px; box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5); }
                .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            </style>
        </head>
        <body class="p-4 md:p-8 max-w-7xl mx-auto">
            <div class="flex justify-between items-center mb-8 gap-4 flex-wrap">
                <div>
                    <a href="/" class="text-cyan-300 hover:text-cyan-200 text-sm underline underline-offset-4">← Zurück zum Dashboard</a>
                    <h1 class="text-3xl font-extrabold mt-3">Wal-Detailansicht</h1>
                    <p class="text-slate-400 font-mono mt-2">${escapeHtml(whaleAddress)}</p>
                </div>
                <div class="text-right">
                    <div class="text-xs text-slate-500 uppercase tracking-wider">Modus</div>
                    <div class="text-lg font-bold ${whale?.mode === 'paper' ? 'text-amber-300' : 'text-emerald-300'}">${escapeHtml(whale?.mode ?? 'untracked')}</div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-6 gap-4 mb-8">
                <div class="glass-card border-t-4 border-t-cyan-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">12h TX</h2><p class="text-3xl font-black">${txRows.length}</p></div>
                <div class="glass-card border-t-4 border-t-emerald-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Live Bewertet</h2><p class="text-3xl font-black text-emerald-400">${liveSummary.evaluatedTrades}</p><p class="text-xs text-slate-500 mt-1">Win ${liveSummary.winRatePct === null ? 'n/a' : `${liveSummary.winRatePct.toFixed(0)}%`} · Avg ${formatPct(liveSummary.avgPnlPct)}</p></div>
                <div class="glass-card border-t-4 border-t-amber-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Paper Bewertet</h2><p class="text-3xl font-black text-amber-300">${paperSummary.evaluatedTrades}</p><p class="text-xs text-slate-500 mt-1">Win ${paperSummary.winRatePct === null ? 'n/a' : `${paperSummary.winRatePct.toFixed(0)}%`} · Avg ${formatPct(paperSummary.avgPnlPct)}</p></div>
                <div class="glass-card border-t-4 border-t-rose-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Paper Verworfen</h2><p class="text-3xl font-black text-rose-300">${paperSummary.noPriceDiscards}</p><p class="text-xs text-slate-500 mt-1">Streak ${paperSummary.streak || 'n/a'}</p></div>
                <div class="glass-card border-t-4 border-t-purple-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Entdeckt</h2><p class="text-sm font-bold text-slate-200 mt-2">${formatDateTime(whale?.discoveredAt)}</p></div>
                <div class="glass-card border-t-4 border-t-sky-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Seed Ranking</h2><p class="text-xl font-black text-sky-300">${Number.isFinite(Number(whale?.seedTraderRank)) ? `#${Number(whale?.seedTraderRank)}` : 'n/a'}</p><p class="text-xs text-slate-500 mt-1">${escapeHtml(shortenAddress(String(whale?.lastScoutedToken ?? 'n/a'), 8, 4))} · $${Number.isFinite(Number(whale?.seedTokenVolumeUsd)) ? Number(whale?.seedTokenVolumeUsd).toFixed(0) : 'n/a'}</p></div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
                <div class="glass-card lg:col-span-2">
                    <h2 class="text-xl font-bold mb-6">Transaktionen der letzten 12 Stunden</h2>
                    ${txTable}
                </div>
                <div class="glass-card">
                    <h2 class="text-xl font-bold mb-6">Bot-Erkennung für diesen Wal</h2>
                    <div class="max-h-[560px] overflow-y-auto custom-scrollbar pr-2">${activityHtml}</div>
                </div>
            </div>
        </body>
        </html>`;

        res.send(html);
    } catch (error: any) {
        res.status(500).send(`Konnte Wal-Details nicht laden: ${escapeHtml(error?.message ?? 'unknown error')}`);
    }
});

app.get('/', (req, res) => {
    const actionMessage = typeof req.query.message === 'string' ? req.query.message : '';
    const actionError = typeof req.query.error === 'string' ? req.query.error : '';
    const whales = readWhales();
    const activeTrades = safeReadJSON('active-trades.json', {});
    const paperTrades = safeReadJSON('paper-trades.json', {});
    const whaleStatsStore = readWhaleStats();
    const whaleActivity = safeReadJSON('whale-activity.json', []);
    const runtimeStatus = readRuntimeStatus();
    const history = safeReadJSON('trade-history.json', []); // NEU: Historie laden!
    const paperWhales = whales.filter((whale) => whale.mode === 'paper').length;
    const liveWhales = whales.length - paperWhales;
    const knownWhaleAddresses = Array.from(new Set([...whales.map((whale) => whale.address), ...Object.keys(whaleStatsStore)]));
    const summaryByAddress = new Map(knownWhaleAddresses.map((address) => [address, getWhaleSummaries(whaleStatsStore, address)]));

    const liveLeaderboardStats = knownWhaleAddresses
        .map((address) => {
            const whale = whales.find((entry) => entry.address === address);
            const liveSummary = summaryByAddress.get(address)?.live ?? createEmptySummary();
            return {
                address,
                mode: whale?.mode ?? 'untracked',
                wins: liveSummary.wins,
                losses: liveSummary.losses,
                total: liveSummary.evaluatedTrades,
                streak: liveSummary.streak,
                winRate: liveSummary.winRatePct === null ? null : Math.round(liveSummary.winRatePct),
                avgPnlPct: liveSummary.avgPnlPct,
                medianPnlPct: liveSummary.medianPnlPct,
                panicExitRatePct: liveSummary.panicExitRatePct,
            };
        })
        .filter((stat) => stat.total > 0)
        .sort((left, right) => {
            const avgDiff = (right.avgPnlPct ?? Number.NEGATIVE_INFINITY) - (left.avgPnlPct ?? Number.NEGATIVE_INFINITY);
            if (avgDiff !== 0) {
                return avgDiff;
            }

            return (right.winRate ?? -1) - (left.winRate ?? -1);
        });

    const totalWins = liveLeaderboardStats.reduce((sum, stat) => sum + stat.wins, 0);
    const totalLosses = liveLeaderboardStats.reduce((sum, stat) => sum + stat.losses, 0);
    const totalTrades = liveLeaderboardStats.reduce((sum, stat) => sum + stat.total, 0);
    const globalWinRate = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;
    const totalPaperEvaluated = whales.reduce((sum, whale) => sum + (summaryByAddress.get(whale.address)?.paper.evaluatedTrades ?? 0), 0);
    const totalPaperDiscards = whales.reduce((sum, whale) => sum + (summaryByAddress.get(whale.address)?.paper.noPriceDiscards ?? 0), 0);

    const paperWhaleStats = whales
        .filter((whale) => whale.mode === 'paper')
        .map((whale) => {
            const paperSummary = summaryByAddress.get(whale.address)?.paper ?? createEmptySummary();
            return {
                ...whale,
                wins: paperSummary.wins,
                losses: paperSummary.losses,
                total: paperSummary.evaluatedTrades,
                streak: paperSummary.streak,
                winRate: paperSummary.winRatePct === null ? null : Math.round(paperSummary.winRatePct),
                avgPnlPct: paperSummary.avgPnlPct,
                medianPnlPct: paperSummary.medianPnlPct,
                noPriceDiscards: paperSummary.noPriceDiscards,
                readyForPromotion: isPromotionReady(paperSummary),
            };
        })
        .sort((a, b) => {
            const leftReady = a.readyForPromotion ? 1 : 0;
            const rightReady = b.readyForPromotion ? 1 : 0;
            if (rightReady !== leftReady) {
                return rightReady - leftReady;
            }

            if ((b.total ?? 0) !== (a.total ?? 0)) {
                return (b.total ?? 0) - (a.total ?? 0);
            }

            return Date.parse(b.discoveredAt ?? '') - Date.parse(a.discoveredAt ?? '');
        });
    const paperTradeCount = Object.keys(paperTrades).length;
    const historyRows = Array.isArray(history) ? history : [];
    const finalizedHistoryRows = historyRows.filter((trade: any) => trade?.partial !== true);
    const partialHistoryCount = historyRows.filter((trade: any) => trade?.partial === true).length;
    const realizedPnlValues = finalizedHistoryRows
        .map((trade: any) => Number(trade.combinedPnlPct ?? trade.pnl))
        .filter((value: number) => Number.isFinite(value));
    const averageRealizedPnl = realizedPnlValues.length > 0
        ? realizedPnlValues.reduce((sum: number, value: number) => sum + value, 0) / realizedPnlValues.length
        : 0;
    const activeTradeRows = Object.values(activeTrades);
    const openRunnerCount = activeTradeRows.filter((trade: any) => hasTakeProfitTakenFlag(trade)).length;
    const openPartialCount = activeTradeRows.filter((trade: any) => getRealizedSoldFraction(trade) > 0).length;
    const trimPendingCount = activeTradeRows.filter((trade: any) => getPendingWhaleTrimFraction(trade) > 0).length;
    const scoutStatus = runtimeStatus.scout ?? {};
    const trackerStatus = runtimeStatus.tracker ?? {};
    const monitorStatus = runtimeStatus.positionManager ?? {};
    const alertHTML = actionError
        ? `<div class="glass-card border-t-4 border-t-red-500 mb-8"><p class="text-sm font-semibold text-red-300">${escapeHtml(actionError)}</p></div>`
        : (actionMessage
            ? `<div class="glass-card border-t-4 border-t-emerald-500 mb-8"><p class="text-sm font-semibold text-emerald-300">${escapeHtml(actionMessage)}</p></div>`
            : '');
    const paperResetActionsHTML = `
        <div class="flex flex-wrap items-center gap-3">
            <form method="POST" action="/actions/reset-paper-all" onsubmit="return confirm('Alle Paper-Bewertungen, Discards und offenen Paper-Trades wirklich zuruecksetzen?');">
                <button type="submit" class="px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-xs font-bold uppercase tracking-wide hover:bg-red-500/20 transition-colors">Reset Alle Paper-Bewertungen</button>
            </form>
            <form method="POST" action="/actions/reset-whales-all" onsubmit="return confirm('Wirklich alle Wale inklusive Whale-Stats, Whale-Activity und Paper-Daten loeschen? Aktive Live-Trades bleiben bestehen.');">
                <button type="submit" class="px-3 py-2 rounded-lg border border-rose-400/50 bg-rose-500/15 text-rose-200 text-xs font-bold uppercase tracking-wide hover:bg-rose-500/25 transition-colors">Alle Wale Loeschen</button>
            </form>
            <span class="text-xs text-slate-500">Loescht Paper-Metriken, Discards und offene Paper-Trades der Quarantaene.</span>
        </div>`;

    const statusCardsHTML = `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div class="glass-card border-t-4 border-t-cyan-500">
                <h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Scout</h2>
                <p class="text-lg font-black text-cyan-300">${escapeHtml(String(scoutStatus.state ?? 'n/a'))}</p>
                <p class="text-xs text-slate-500 mt-1">Letzter Lauf ${formatDateTime(scoutStatus.lastRunAt)}</p>
                <p class="text-xs text-slate-500">Token ${escapeHtml(shortenAddress(String(scoutStatus.lastToken ?? 'n/a'), 8, 4))}</p>
                <p class="text-xs text-slate-500">Seeds ${escapeHtml(String(scoutStatus.highVolumeSeedCount ?? 0))}/${escapeHtml(String(scoutStatus.eligibleSeedCount ?? scoutStatus.migratedSeedCount ?? 0))} high-volume · Cooldown ${escapeHtml(String(scoutStatus.cooldownSkippedCandidates ?? 0))}</p>
                <p class="text-xs text-slate-500">Quellen Boost ${escapeHtml(String(scoutStatus.boostSeedInputCount ?? 0))} · Market ${escapeHtml(String(scoutStatus.marketSeedInputCount ?? 0))} · Merge ${escapeHtml(String(scoutStatus.mergedSeedInputCount ?? 0))}</p>
                <p class="text-xs text-slate-500">On-Chain Seeds ${escapeHtml(String(scoutStatus.seedCheckInputCount ?? 0))}</p>
                <p class="text-xs text-slate-500">Filter Vol24h $${escapeHtml(String(scoutStatus.minSeedVolumeUsd ?? 'n/a'))} · Seed-Wal $${escapeHtml(String(scoutStatus.minSeedTraderVolumeUsd ?? 'n/a'))}</p>
                <p class="text-xs text-slate-500">Next ${formatDateTime(scoutStatus.nextRunAt)}</p>
            </div>
            <div class="glass-card border-t-4 border-t-emerald-500">
                <h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Tracker</h2>
                <p class="text-lg font-black text-emerald-300">${escapeHtml(String(trackerStatus.activeSubscriptions ?? 0))} Subs</p>
                <p class="text-xs text-slate-500 mt-1">Whales ${escapeHtml(String(trackerStatus.whaleCount ?? 0))}</p>
                <p class="text-xs text-slate-500">Letztes Signal ${formatDateTime(trackerStatus.lastSignalAt)}</p>
                <p class="text-xs text-slate-500">${escapeHtml(String(trackerStatus.lastSignalSide ?? 'n/a'))} ${escapeHtml(shortenAddress(String(trackerStatus.lastSignalMint ?? 'n/a'), 8, 4))}</p>
            </div>
            <div class="glass-card border-t-4 border-t-amber-500">
                <h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Monitor</h2>
                <p class="text-lg font-black text-amber-300">${escapeHtml(String(monitorStatus.state ?? 'n/a'))}</p>
                <p class="text-xs text-slate-500 mt-1">Paper ${escapeHtml(String(monitorStatus.openPaperTrades ?? 0))} · Live ${escapeHtml(String(monitorStatus.openLiveTrades ?? 0))}</p>
                <p class="text-xs text-slate-500">Cache ${escapeHtml(String(monitorStatus.priceCacheEntries ?? 0))}</p>
                <p class="text-xs text-slate-500">Letzter Lauf ${formatDateTime(monitorStatus.lastRunAt)}</p>
            </div>
        </div>`;

    // Aktive Trades generieren
    let activeTradesHTML = '<p class="text-slate-500 text-center py-8 italic">Keine aktiven Trades.</p>';
    if (Object.keys(activeTrades).length > 0) {
        const rows = Object.entries(activeTrades).map(([mint, tData]: any) => {
            const whaleStr = (typeof tData === 'string' ? tData : tData.whale) || 'Unknown';
            const entryPrice = typeof tData === 'object' ? formatUsd(tData.entryPrice) : 'n/a';
            const entrySource = typeof tData === 'object' ? (tData.entryPriceSource || 'legacy') : 'legacy';
            const positionSol = typeof tData === 'object' && Number.isFinite(Number(tData.positionSol)) ? `${Number(tData.positionSol).toFixed(2)} SOL` : 'n/a';
            const remainingFraction = typeof tData === 'object' ? getRemainingPositionFraction(tData) : 1;
            const realizedSoldFraction = typeof tData === 'object' ? getRealizedSoldFraction(tData) : 0;
            const realizedPnlPct = typeof tData === 'object' ? getRealizedPnlPctValue(tData) : null;
            const pendingTrimFraction = typeof tData === 'object' ? getPendingWhaleTrimFraction(tData) : 0;
            const lastActionReason = typeof tData === 'object' && typeof tData.lastPartialExitReason === 'string' ? tData.lastPartialExitReason : null;
            const lastActionAt = typeof tData === 'object' ? formatDateTime(tData.lastPartialExitAt ?? tData.openedAt) : 'n/a';
            const statusBadges: string[] = [];

            if (typeof tData === 'object' && tData.panic) {
                statusBadges.push('<span class="text-red-300 bg-red-500/10 px-2 py-1 rounded">panic</span>');
            }
            if (typeof tData === 'object' && tData.recoveredFromWallet) {
                statusBadges.push('<span class="text-sky-300 bg-sky-500/10 px-2 py-1 rounded">wallet</span>');
            }
            if (typeof tData === 'object' && hasTakeProfitTakenFlag(tData)) {
                statusBadges.push(`<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">runner ${formatFractionPct(remainingFraction)}</span>`);
            }
            if (realizedSoldFraction > 0 && !hasTakeProfitTakenFlag(tData)) {
                statusBadges.push(`<span class="text-cyan-300 bg-cyan-500/10 px-2 py-1 rounded">partial ${formatFractionPct(realizedSoldFraction)}</span>`);
            }
            if (pendingTrimFraction > 0) {
                statusBadges.push(`<span class="text-sky-300 bg-sky-500/10 px-2 py-1 rounded">trim offen ${formatFractionPct(pendingTrimFraction)}</span>`);
            }
            if (statusBadges.length === 0) {
                statusBadges.push(entryPrice === 'n/a'
                    ? '<span class="text-amber-300 bg-amber-500/10 px-2 py-1 rounded">entry fehlt</span>'
                    : '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">tracked</span>');
            }

            return `
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td class="py-3 pl-2 font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${mint}" target="_blank">${mint.slice(0, 8)}...${mint.slice(-4)}</a></td>
                <td class="py-3 font-mono text-xs text-slate-400">${renderWhaleLink(whaleStr, `${whaleStr.slice(0,6)}...`)}</td>
                <td class="py-3 text-xs text-slate-300">${entryPrice}</td>
                <td class="py-3 text-xs text-slate-400">${escapeHtml(entrySource)}</td>
                <td class="py-3 text-xs text-slate-300">${positionSol}<div class="text-[11px] text-slate-500">Offen ${formatFractionPct(remainingFraction)} · Verkauft ${formatFractionPct(realizedSoldFraction)}</div></td>
                <td class="py-3 text-xs text-slate-300">${formatPct(realizedPnlPct)}<div class="text-[11px] text-slate-500">realisiert</div></td>
                <td class="py-3 text-xs text-slate-400">${escapeHtml(lastActionReason ?? 'Entry')}<div class="text-[11px] text-slate-500">${lastActionAt}</div></td>
                <td class="py-3 text-right pr-2 text-xs">${statusBadges.join(' ')}</td>
            </tr>`;
        }).join('');
        activeTradesHTML = `
        <table class="w-full text-left">
            <thead>
                <tr class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700/50">
                    <th class="pb-3 pl-2">Token</th>
                    <th class="pb-3">Wal</th>
                    <th class="pb-3">Entry USD</th>
                    <th class="pb-3">Quelle</th>
                    <th class="pb-3">Size</th>
                    <th class="pb-3">Realisiert</th>
                    <th class="pb-3">Letzte Aktion</th>
                    <th class="pb-3 pr-2 text-right">Status</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    let paperTradesHTML = '<p class="text-slate-500 text-center py-8 italic">Keine offenen Paper-Trades.</p>';
    if (paperTradeCount > 0) {
        const rows = Object.values(paperTrades).map((trade: any) => {
            const whaleAddress = typeof trade?.whale === 'string' ? trade.whale : 'Unknown';
            const openedAt = typeof trade?.openedAt === 'string' ? trade.openedAt : null;
            const paperEntry = Number(trade?.entryPrice);
            const entrySource = typeof trade?.entryPriceSource === 'string' ? trade.entryPriceSource : 'legacy';
            const paperEntryDisplay = entrySource === 'wallet-receipt-sol-only'
                ? formatSolPrice(Number.isFinite(Number(trade?.entryPriceSol)) ? trade.entryPriceSol : trade?.entryPrice)
                : formatUsd(paperEntry);
            const paperSummary = summaryByAddress.get(whaleAddress)?.paper ?? createEmptySummary();
            const remainingFraction = getRemainingPositionFraction(trade);
            const realizedPnlPct = getRealizedPnlPctValue(trade);
            const lastActionReason = typeof trade?.lastPartialExitReason === 'string' ? trade.lastPartialExitReason : null;
            const lastActionAt = formatDateTime(trade?.lastPartialExitAt ?? openedAt);
            const statusBadge = trade?.panic
                ? '<span class="text-red-300 bg-red-500/10 px-2 py-1 rounded">panic</span>'
                : hasTakeProfitTakenFlag(trade)
                    ? `<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">runner ${formatFractionPct(remainingFraction)}</span>`
                : Number.isFinite(Number(trade?.whaleSoldFraction)) && Number(trade?.whaleSoldFraction) > 0
                    ? `<span class="text-sky-300 bg-sky-500/10 px-2 py-1 rounded">trim ${(Number(trade.whaleSoldFraction) * 100).toFixed(0)}%</span>`
                : '<span class="text-amber-300 bg-amber-500/10 px-2 py-1 rounded">paper</span>';
            return `
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td class="py-3 pl-2 font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${trade.mint}" target="_blank">${String(trade.mint).slice(0, 8)}...${String(trade.mint).slice(-4)}</a></td>
                <td class="py-3 font-mono text-xs text-slate-400">${escapeHtml(whaleAddress.slice(0,8))}...</td>
                <td class="py-3 text-xs text-slate-300">${paperEntryDisplay}<div class="text-[11px] text-slate-500">${escapeHtml(formatEntrySourceLabel(entrySource))}</div></td>
                <td class="py-3 text-xs text-slate-400">${formatDateTime(openedAt)}<div class="text-[11px] text-slate-500">Offen ${formatFractionPct(remainingFraction)}</div></td>
                <td class="py-3 text-xs text-slate-300">${formatPct(realizedPnlPct)}<div class="text-[11px] text-slate-500">${escapeHtml(lastActionReason ?? 'noch kein partial')} · ${lastActionAt}</div></td>
                <td class="py-3 text-xs text-slate-400">${paperSummary.evaluatedTrades}/${env.PAPER_PROMOTION_MIN_TRADES} bewertet · ${paperSummary.noPriceDiscards} verworfen</td>
                <td class="py-3 text-right pr-2 text-xs">${statusBadge}</td>
            </tr>`;
        }).join('');
        paperTradesHTML = `
        <table class="w-full text-left">
            <thead>
                <tr class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700/50">
                    <th class="pb-3 pl-2">Token</th>
                    <th class="pb-3">Wal</th>
                    <th class="pb-3">Entry</th>
                    <th class="pb-3">Opened</th>
                    <th class="pb-3">Realisiert</th>
                    <th class="pb-3">Sample</th>
                    <th class="pb-3 pr-2 text-right">Status</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    // Wal Leaderboard generieren
    let whaleStatsHTML = '<p class="text-slate-500 text-center py-8 italic">Keine Daten.</p>';
    if (liveLeaderboardStats.length > 0) {
        whaleStatsHTML = liveLeaderboardStats.map(stat => `
            <div class="flex justify-between items-center py-3 border-b border-slate-800/50">
                <div>
                    <div class="font-mono text-sm text-slate-300">${renderWhaleLink(stat.address, `${stat.address.slice(0,8)}...`)}</div>
                    <div class="text-[11px] text-slate-500">Streak: ${stat.streak || 'n/a'} · Trades: ${stat.total} · Median ${formatPct(stat.medianPnlPct)}</div>
                </div>
                <div class="flex space-x-3 text-xs font-bold">
                    <span class="text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded">W: ${stat.wins}</span>
                    <span class="text-red-400 bg-red-400/10 px-2 py-1 rounded">L: ${stat.losses}</span>
                    <span class="${(stat.avgPnlPct ?? 0) >= 0 ? 'text-blue-400' : 'text-red-300'} min-w-[72px] text-right">${formatPct(stat.avgPnlPct)}</span>
                    <span class="${(stat.winRate ?? 0) >= 50 ? 'text-blue-400' : 'text-slate-500'} w-10 text-right">${stat.winRate === null ? 'n/a' : `${stat.winRate}%`}</span>
                </div>
            </div>`).join('');
    }

    let paperWhalesHTML = '<p class="text-slate-500 text-center py-8 italic">Keine Paper-Wale in Quarantäne.</p>';
    if (paperWhaleStats.length > 0) {
        paperWhalesHTML = paperWhaleStats.map((stat) => {
            const statusBadge = stat.readyForPromotion
                ? '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">promotion ready</span>'
                : `<span class="text-slate-300 bg-slate-700/40 px-2 py-1 rounded">${stat.total}/${env.PAPER_PROMOTION_MIN_TRADES} bewertet</span>`;
            const resetAction = `
                <form method="POST" action="/actions/reset-paper-whale" onsubmit="return confirm('Paper-Daten fuer ${escapeHtml(stat.address.slice(0, 8))} wirklich resetten?');" class="mt-2">
                    <input type="hidden" name="whaleAddress" value="${escapeHtml(stat.address)}">
                    <button type="submit" class="px-2 py-1 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-[10px] font-bold uppercase tracking-wide hover:bg-red-500/20 transition-colors">Reset</button>
                </form>`;
            return `
            <div class="flex justify-between items-center py-3 border-b border-slate-800/50">
                <div>
                    <div class="font-mono text-sm text-slate-300">${renderWhaleLink(stat.address, `${stat.address.slice(0,8)}...`)}</div>
                    <div class="text-[11px] text-slate-500">Discovery: ${formatDateTime(stat.discoveredAt)} · Streak: ${stat.streak || 'n/a'} · Discards: ${stat.noPriceDiscards}</div>
                    <div class="text-[11px] text-slate-500">Seed ${escapeHtml(shortenAddress(String(stat.lastScoutedToken ?? 'n/a'), 8, 4))} · Rank ${Number.isFinite(Number(stat.seedTraderRank)) ? `#${Number(stat.seedTraderRank)}` : 'n/a'} · Vol $${Number.isFinite(Number(stat.seedTokenVolumeUsd)) ? Number(stat.seedTokenVolumeUsd).toFixed(0) : 'n/a'} · Trades ${Number.isFinite(Number(stat.seedTokenTradeCount)) ? Number(stat.seedTokenTradeCount).toFixed(0) : 'n/a'}</div>
                </div>
                <div class="text-right">
                    <div class="text-xs font-bold text-amber-300">${stat.winRate === null ? 'n/a' : `${stat.winRate}%`} · Avg ${formatPct(stat.avgPnlPct)}</div>
                    <div class="text-[11px] text-slate-500 mb-1">W ${stat.wins} / L ${stat.losses} · Median ${formatPct(stat.medianPnlPct)}</div>
                    ${statusBadge}
                    ${resetAction}
                </div>
            </div>`;
        }).join('');
    }

    let whaleActivityHTML = '<p class="text-slate-500 text-center py-8 italic">Noch keine erkannten Wal-Trades.</p>';
    if (Array.isArray(whaleActivity) && whaleActivity.length > 0) {
        const rows = whaleActivity.slice(0, 20).map((entry: any) => {
            const isBuy = entry?.side === 'buy';
            const sideBadge = isBuy
                ? '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">buy</span>'
                : '<span class="text-red-300 bg-red-500/10 px-2 py-1 rounded">sell</span>';
            const modeBadge = entry?.botMode === 'paper'
                ? '<span class="text-amber-300 bg-amber-500/10 px-2 py-1 rounded">paper</span>'
                : '<span class="text-sky-300 bg-sky-500/10 px-2 py-1 rounded">live</span>';
            const mint = typeof entry?.mint === 'string' ? entry.mint : 'Unknown';
            const whale = typeof entry?.whale === 'string' ? entry.whale : 'Unknown';
            const signature = typeof entry?.signature === 'string' ? entry.signature : null;

            return `
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                <td class="py-3 pl-2 text-xs text-slate-400">${formatDateTime(entry?.detectedAt)}</td>
                <td class="py-3 font-mono text-sm text-slate-300">${renderWhaleLink(whale, `${whale.slice(0,8)}...`)}</td>
                <td class="py-3 font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${mint}" target="_blank">${escapeHtml(mint.slice(0, 8))}...${escapeHtml(mint.slice(-4))}</a></td>
                <td class="py-3 text-xs">${sideBadge}</td>
                <td class="py-3 text-xs">${modeBadge}</td>
                <td class="py-3 text-xs text-slate-400">${signature ? `<a href="https://solscan.io/tx/${signature}" target="_blank">${escapeHtml(signature.slice(0,8))}...</a>` : 'n/a'}</td>
            </tr>`;
        }).join('');

        whaleActivityHTML = `
        <div class="overflow-x-auto max-h-[320px] custom-scrollbar">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700/50">
                        <th class="pb-3 pl-2">Zeit</th>
                        <th class="pb-3">Wal</th>
                        <th class="pb-3">Token</th>
                        <th class="pb-3">Side</th>
                        <th class="pb-3">Bot-Modus</th>
                        <th class="pb-3">Tx</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    // NEU: Trade Historie generieren
    let historyHTML = '<p class="text-slate-500 text-center py-8 italic">Noch keine abgeschlossenen Trades aufgezeichnet.</p>';
    if (historyRows.length > 0) {
        const rows = historyRows.map((trade: any) => {
            const isProfit = Number(trade.pnl) > 0;
            const pnlColor = isProfit ? 'text-emerald-400' : 'text-red-400';
            const bgBadge = isProfit ? 'bg-emerald-400/10' : 'bg-red-400/10';
            const isPartial = trade?.partial === true;
            const sourceBadge = trade.priceSource === 'receipt'
                ? '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">receipt</span>'
                : '<span class="text-amber-300 bg-amber-500/10 px-2 py-1 rounded">fallback</span>';
            const typeBadge = isPartial
                ? '<span class="text-cyan-300 bg-cyan-500/10 px-2 py-1 rounded">partial</span>'
                : '<span class="text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">final</span>';
            const soldFractionPct = Number.isFinite(Number(trade?.soldFractionPct)) ? `${Number(trade.soldFractionPct).toFixed(1)}%` : 'n/a';
            const remainingFractionPct = Number.isFinite(Number(trade?.remainingFractionPct)) ? `${Number(trade.remainingFractionPct).toFixed(1)}%` : '0.0%';
            const combinedPnl = Number.isFinite(Number(trade?.combinedPnlPct)) ? formatPct(trade.combinedPnlPct) : formatPct(trade?.pnl);
            return `
            <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                <td class="py-3 pl-2 text-xs text-slate-400">${trade.date}</td>
                <td class="py-3 font-mono text-sm text-cyan-300"><a href="https://solscan.io/token/${trade.mint}" target="_blank">${trade.mint.slice(0, 6)}...</a></td>
                <td class="py-3 text-xs">${typeBadge}<div class="text-[11px] text-slate-500 mt-1">${trade.reason}</div></td>
                <td class="py-3 text-xs text-slate-400">${soldFractionPct}<div class="text-[11px] text-slate-500">Rest ${remainingFractionPct}</div></td>
                <td class="py-3 text-xs text-slate-300">${formatUsd(trade.entryPriceUsd)} → ${formatUsd(trade.exitPriceUsd)}</td>
                <td class="py-3 text-xs text-slate-400">${formatSolPrice(trade.entryPriceSol)} → ${formatSolPrice(trade.exitPriceSol)}</td>
                <td class="py-3 text-xs">${sourceBadge}</td>
                <td class="py-3 text-right pr-2 font-bold ${pnlColor}"><span class="${bgBadge} px-2 py-1 rounded">${formatPct(trade.pnl)}</span><div class="text-[11px] text-slate-500 mt-1">cum ${combinedPnl}</div></td>
            </tr>`;
        }).join('');
        
        historyHTML = `
        <div class="overflow-x-auto max-h-[300px] custom-scrollbar">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700/50">
                        <th class="pb-3 pl-2">Datum</th>
                        <th class="pb-3">Token</th>
                        <th class="pb-3">Typ</th>
                        <th class="pb-3">Anteil</th>
                        <th class="pb-3">USD Fill</th>
                        <th class="pb-3">SOL/Token</th>
                        <th class="pb-3">Quelle</th>
                        <th class="pb-3 text-right pr-2">PnL</th>
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

        <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            <div class="glass-card border-t-4 border-t-blue-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Wale</h2><p class="text-3xl font-black">${whales.length}</p><p class="text-xs text-slate-500 mt-1">Live ${liveWhales} · Paper ${paperWhales}</p></div>
            <div class="glass-card border-t-4 border-t-yellow-400"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Positionen</h2><p class="text-3xl font-black text-yellow-400">${Object.keys(activeTrades).length}</p><p class="text-xs text-slate-500 mt-1">Runner ${openRunnerCount} · Partial ${openPartialCount} · Trim ${trimPendingCount}</p></div>
            <div class="glass-card border-t-4 border-t-amber-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Paper Offen</h2><p class="text-3xl font-black text-amber-300">${paperTradeCount}</p><p class="text-xs text-slate-500 mt-1">Bewertet ${totalPaperEvaluated} · Verworfen ${totalPaperDiscards}</p></div>
            <div class="glass-card border-t-4 border-t-purple-500"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Live Bewertet</h2><p class="text-3xl font-black">${totalTrades}</p><p class="text-xs text-slate-500 mt-1">Final ${finalizedHistoryRows.length} · Partial ${partialHistoryCount}</p></div>
            <div class="glass-card border-t-4 ${averageRealizedPnl >= 0 ? 'border-t-emerald-500' : 'border-t-red-500'}"><h2 class="text-slate-400 text-xs font-bold uppercase mb-1">Avg Realized PnL</h2><p class="text-3xl font-black ${averageRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}">${formatPct(averageRealizedPnl)}</p><p class="text-xs text-slate-500 mt-1">Win-Rate ${globalWinRate}%</p></div>
        </div>

        ${alertHTML}
        ${statusCardsHTML}

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            <div class="glass-card"><h2 class="text-xl font-bold mb-4 flex items-center"><span class="bg-yellow-500/20 p-2 rounded-lg mr-3 text-yellow-500">🎯</span> Live Positionen</h2><div class="overflow-x-auto">${activeTradesHTML}</div></div>
            <div class="glass-card"><h2 class="text-xl font-bold mb-4 flex items-center"><span class="bg-purple-500/20 p-2 rounded-lg mr-3 text-purple-400">🏆</span> Wal Leaderboard</h2><div class="max-h-[300px] overflow-y-auto custom-scrollbar pr-2">${whaleStatsHTML}</div></div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            <div class="glass-card"><h2 class="text-xl font-bold mb-4 flex items-center"><span class="bg-amber-500/20 p-2 rounded-lg mr-3 text-amber-300">🧪</span> Paper Trades</h2><div class="overflow-x-auto">${paperTradesHTML}</div></div>
            <div class="glass-card"><div class="flex flex-col gap-4 mb-4"><h2 class="text-xl font-bold flex items-center"><span class="bg-cyan-500/20 p-2 rounded-lg mr-3 text-cyan-300">🛰️</span> Quarantäne-Wale</h2>${paperResetActionsHTML}</div><div class="max-h-[300px] overflow-y-auto custom-scrollbar pr-2">${paperWhalesHTML}</div></div>
        </div>

        <div class="glass-card mb-8">
            <h2 class="text-xl font-bold mb-6 flex items-center">
                <span class="bg-rose-500/20 p-2 rounded-lg mr-3 text-rose-300">📡</span> Letzte Wal-Trades
            </h2>
            ${whaleActivityHTML}
        </div>

        <div class="glass-card">
            <h2 class="text-xl font-bold mb-6 flex items-center">
                <span class="bg-blue-500/20 p-2 rounded-lg mr-3 text-blue-400">🧾</span> Letzte Exits (inkl. Partial)
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
