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