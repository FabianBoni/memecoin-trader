import { getDatabase, isDatabaseEnabled } from './database.js';
import { readJsonFileSync, writeJsonFileSync } from './json-file-sync.js';
import { resolveSrcDataPath } from '../utils/repo-paths.js';

const WHALES_PATH = resolveSrcDataPath('whales.json');

export type WhaleMode = 'paper' | 'live';

export interface WhaleRecord {
  address: string;
  mode: WhaleMode;
  discoveredAt?: string;
  promotedAt?: string | null;
  paperTrades?: number;
  liveTrades?: number;
  estimatedVolumeUsd?: number;
  qualifyingTradeCount?: number;
  distinctTokenCount?: number;
  lastScoutedAt?: string;
  lastScoutedToken?: string;
  lastScoutedReason?: string;
  seedTraderRank?: number;
  seedTokenVolumeUsd?: number;
  seedTokenTradeCount?: number;
}

type WhaleRow = {
  address: string;
  mode: WhaleMode;
  discovered_at: string | null;
  promoted_at: string | null;
  paper_trades: number;
  live_trades: number;
  estimated_volume_usd: number | null;
  qualifying_trade_count: number | null;
  distinct_token_count: number | null;
  last_scouted_at: string | null;
  last_scouted_token: string | null;
  last_scouted_reason: string | null;
  seed_trader_rank: number | null;
  seed_token_volume_usd: number | null;
  seed_token_trade_count: number | null;
};

function normalizeWhale(input: unknown): WhaleRecord | null {
  if (typeof input === 'string') {
    return {
      address: input,
      mode: 'paper',
      promotedAt: null,
      paperTrades: 0,
      liveTrades: 0,
    };
  }

  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  if (typeof candidate.address !== 'string' || candidate.address.trim().length === 0) {
    return null;
  }

  const mode = candidate.mode === 'live' ? 'live' : 'paper';
  return {
    address: candidate.address,
    mode,
    ...(typeof candidate.discoveredAt === 'string' ? { discoveredAt: candidate.discoveredAt } : {}),
    promotedAt: typeof candidate.promotedAt === 'string' ? candidate.promotedAt : null,
    ...(Number.isFinite(Number(candidate.paperTrades)) ? { paperTrades: Number(candidate.paperTrades) } : { paperTrades: 0 }),
    ...(Number.isFinite(Number(candidate.liveTrades)) ? { liveTrades: Number(candidate.liveTrades) } : { liveTrades: 0 }),
    ...(Number.isFinite(Number(candidate.estimatedVolumeUsd)) ? { estimatedVolumeUsd: Number(candidate.estimatedVolumeUsd) } : {}),
    ...(Number.isFinite(Number(candidate.qualifyingTradeCount)) ? { qualifyingTradeCount: Number(candidate.qualifyingTradeCount) } : {}),
    ...(Number.isFinite(Number(candidate.distinctTokenCount)) ? { distinctTokenCount: Number(candidate.distinctTokenCount) } : {}),
    ...(typeof candidate.lastScoutedAt === 'string' ? { lastScoutedAt: candidate.lastScoutedAt } : {}),
    ...(typeof candidate.lastScoutedToken === 'string' ? { lastScoutedToken: candidate.lastScoutedToken } : {}),
    ...(typeof candidate.lastScoutedReason === 'string' ? { lastScoutedReason: candidate.lastScoutedReason } : {}),
    ...(Number.isFinite(Number(candidate.seedTraderRank)) ? { seedTraderRank: Number(candidate.seedTraderRank) } : {}),
    ...(Number.isFinite(Number(candidate.seedTokenVolumeUsd)) ? { seedTokenVolumeUsd: Number(candidate.seedTokenVolumeUsd) } : {}),
    ...(Number.isFinite(Number(candidate.seedTokenTradeCount)) ? { seedTokenTradeCount: Number(candidate.seedTokenTradeCount) } : {}),
  };
}

export function normalizeWhales(input: unknown): WhaleRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const deduped = new Map<string, WhaleRecord>();
  for (const item of input) {
    const whale = normalizeWhale(item);
    if (!whale) {
      continue;
    }

    deduped.set(whale.address, whale);
  }

  return Array.from(deduped.values());
}

function readWhalesFromDatabase(): WhaleRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      address,
      mode,
      discovered_at,
      promoted_at,
      paper_trades,
      live_trades,
      estimated_volume_usd,
      qualifying_trade_count,
      distinct_token_count,
      last_scouted_at,
      last_scouted_token,
      last_scouted_reason,
      seed_trader_rank,
      seed_token_volume_usd,
      seed_token_trade_count
    FROM whales
    ORDER BY CASE mode WHEN 'live' THEN 0 ELSE 1 END, COALESCE(promoted_at, discovered_at, last_scouted_at, '') DESC, address ASC
  `).all() as WhaleRow[];

  if (rows.length === 0) {
    const legacyWhales = normalizeWhales(readJsonFileSync(WHALES_PATH, []));
    if (legacyWhales.length > 0) {
      writeWhales(legacyWhales);
      return legacyWhales;
    }
  }

  return rows.map((row) => ({
    address: row.address,
    mode: row.mode,
    ...(row.discovered_at ? { discoveredAt: row.discovered_at } : {}),
    promotedAt: row.promoted_at,
    paperTrades: row.paper_trades,
    liveTrades: row.live_trades,
    ...(row.estimated_volume_usd !== null ? { estimatedVolumeUsd: row.estimated_volume_usd } : {}),
    ...(row.qualifying_trade_count !== null ? { qualifyingTradeCount: row.qualifying_trade_count } : {}),
    ...(row.distinct_token_count !== null ? { distinctTokenCount: row.distinct_token_count } : {}),
    ...(row.last_scouted_at ? { lastScoutedAt: row.last_scouted_at } : {}),
    ...(row.last_scouted_token ? { lastScoutedToken: row.last_scouted_token } : {}),
    ...(row.last_scouted_reason ? { lastScoutedReason: row.last_scouted_reason } : {}),
    ...(row.seed_trader_rank !== null ? { seedTraderRank: row.seed_trader_rank } : {}),
    ...(row.seed_token_volume_usd !== null ? { seedTokenVolumeUsd: row.seed_token_volume_usd } : {}),
    ...(row.seed_token_trade_count !== null ? { seedTokenTradeCount: row.seed_token_trade_count } : {}),
  }));
}

function upsertWhaleRow(whale: WhaleRecord): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO whales (
      address,
      mode,
      discovered_at,
      promoted_at,
      paper_trades,
      live_trades,
      estimated_volume_usd,
      qualifying_trade_count,
      distinct_token_count,
      last_scouted_at,
      last_scouted_token,
      last_scouted_reason,
      seed_trader_rank,
      seed_token_volume_usd,
      seed_token_trade_count,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      mode = excluded.mode,
      discovered_at = excluded.discovered_at,
      promoted_at = excluded.promoted_at,
      paper_trades = excluded.paper_trades,
      live_trades = excluded.live_trades,
      estimated_volume_usd = excluded.estimated_volume_usd,
      qualifying_trade_count = excluded.qualifying_trade_count,
      distinct_token_count = excluded.distinct_token_count,
      last_scouted_at = excluded.last_scouted_at,
      last_scouted_token = excluded.last_scouted_token,
      last_scouted_reason = excluded.last_scouted_reason,
      seed_trader_rank = excluded.seed_trader_rank,
      seed_token_volume_usd = excluded.seed_token_volume_usd,
      seed_token_trade_count = excluded.seed_token_trade_count,
      updated_at = excluded.updated_at
  `).run(
    whale.address,
    whale.mode,
    whale.discoveredAt ?? null,
    whale.promotedAt ?? null,
    whale.paperTrades ?? 0,
    whale.liveTrades ?? 0,
    whale.estimatedVolumeUsd ?? null,
    whale.qualifyingTradeCount ?? null,
    whale.distinctTokenCount ?? null,
    whale.lastScoutedAt ?? null,
    whale.lastScoutedToken ?? null,
    whale.lastScoutedReason ?? null,
    whale.seedTraderRank ?? null,
    whale.seedTokenVolumeUsd ?? null,
    whale.seedTokenTradeCount ?? null,
    new Date().toISOString(),
  );
}

function deleteMissingWhales(addresses: string[]): void {
  const db = getDatabase();
  if (addresses.length === 0) {
    db.prepare('DELETE FROM whales').run();
    return;
  }

  const placeholders = addresses.map(() => '?').join(', ');
  db.prepare(`DELETE FROM whales WHERE address NOT IN (${placeholders})`).run(...addresses);
}

function syncWhaleSnapshot(whales: WhaleRecord[]): void {
  writeJsonFileSync(WHALES_PATH, whales);
}

export function readWhales(): WhaleRecord[] {
  if (!isDatabaseEnabled()) {
    return normalizeWhales(readJsonFileSync(WHALES_PATH, []));
  }

  return readWhalesFromDatabase();
}

export function writeWhales(input: WhaleRecord[]): void {
  const whales = normalizeWhales(input);
  if (!isDatabaseEnabled()) {
    syncWhaleSnapshot(whales);
    return;
  }

  const db = getDatabase();
  const replaceWhales = db.transaction((normalizedWhales: WhaleRecord[]) => {
    for (const whale of normalizedWhales) {
      upsertWhaleRow(whale);
    }

    deleteMissingWhales(normalizedWhales.map((whale) => whale.address));
  });

  replaceWhales(whales);
  syncWhaleSnapshot(whales);
}

export function getWhale(address: string): WhaleRecord | null {
  return readWhales().find((whale) => whale.address === address) ?? null;
}

export function upsertWhale(input: WhaleRecord): void {
  const normalizedWhale = normalizeWhales([input])[0];
  if (!normalizedWhale) {
    return;
  }

  if (!isDatabaseEnabled()) {
    const whales = readWhales();
    const nextWhales = whales.filter((whale) => whale.address !== normalizedWhale.address);
    nextWhales.push(normalizedWhale);
    syncWhaleSnapshot(nextWhales);
    return;
  }

  upsertWhaleRow(normalizedWhale);
  syncWhaleSnapshot(readWhalesFromDatabase());
}

export function patchWhale(address: string, patch: Partial<Omit<WhaleRecord, 'address'>>): void {
  const existingWhale = getWhale(address);
  if (!existingWhale) {
    return;
  }

  upsertWhale({
    ...existingWhale,
    ...patch,
    address,
  });
}

export function removeWhale(address: string): void {
  if (!isDatabaseEnabled()) {
    syncWhaleSnapshot(readWhales().filter((whale) => whale.address !== address));
    return;
  }

  getDatabase().prepare('DELETE FROM whales WHERE address = ?').run(address);
  syncWhaleSnapshot(readWhalesFromDatabase());
}

export function clearWhales(): void {
  if (!isDatabaseEnabled()) {
    syncWhaleSnapshot([]);
    return;
  }

  getDatabase().prepare('DELETE FROM whales').run();
  syncWhaleSnapshot([]);
}