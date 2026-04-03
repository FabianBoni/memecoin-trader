import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { fileURLToPath } from 'url';
import { env, getReadOnlyRpcUrl } from '../config/env.js';
import { DexscreenerClient } from '../clients/dexscreener.js';
import { LiquidityScreenService } from '../services/liquidity-screen.js';
import { getPumpAmmProgramId, getPumpProgramId } from '../solana/pumpfun.js';
import { RAYDIUM_AMM_V4_PROGRAM_IDS } from '../solana/raydium.js';
import { createAsyncLimiter, isSolanaRpcRateLimitError, withRpcRetry } from '../solana/rpc-guard.js';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { readWhales, upsertWhale, type WhaleRecord } from '../storage/whales.js';
import { updateRuntimeStatus } from '../storage/runtime-status.js';
import type { DexPairSummary } from '../types/market.js';
import { describeNonTargetWhaleMint, filterMeaningfulWhaleTargetMints, isNonTargetWhaleMint } from '../utils/whale-targeting.js';

const RPC_URL = getReadOnlyRpcUrl();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCOUT_CANDIDATE_CACHE_FILE = path.resolve(SCRIPT_DIR, '../data/scout-candidate-cache.json');
const EMPTY_SCOUT_INTERVAL_MS = 60 * 1000;
const FAST_SCOUT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SCOUT_INTERVAL_MS = 60 * 60 * 1000;
const FAST_SCOUT_WHALE_TARGET = 100;
const MAX_NEW_WHALES_PER_RUN = 2;
const MAX_CANDIDATES_PER_RUN = 12;
const TOP_TRADERS_PER_TOKEN = 10;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_SOL_USD_FALLBACK = 100;
const SCOUT_SEED_CHECK_CACHE_TTL_MS = 10 * 60 * 1000;
const SCOUT_RPC_RETRY_DELAYS_MS = [400, 900, 1800];
const SCOUT_BATCH_PAUSE_MS = 75;
const SCOUT_MAX_RATE_LIMIT_BATCHES_PER_SCAN = 3;
const SCOUT_TOKEN_PRICE_CACHE_TTL_MS = 60 * 1000;
const SCOUT_MIN_TOKEN_PRICE_LIQUIDITY_USD = 10_000;
const SCOUT_WALLET_EXPOSURE_SKEW_LIMIT = 5;
const MIN_RELIABLE_SCOUT_SOL_DELTA = 0.01;
const SCOUT_WHALE_ADAPTIVE_SIGNATURE_SCAN_CAP = 900;
const SCOUT_DEEP_SCAN_MIN_QUICK_VOLUME_USD = 2_000;
const SCOUT_DEEP_SCAN_MIN_SEED_VOLUME_USD = 500;
const SCOUT_DEEP_SCAN_MIN_QUICK_VOLUME_FOR_STRONG_SEED_USD = 250;
const SPECIALIST_WHALE_VOLUME_FACTOR = 0.4;
const SPECIALIST_WHALE_MIN_VOLUME_USD = 10_000;
const SPECIALIST_WHALE_MIN_TRADE_MULTIPLIER = 2;
const SPECIALIST_WHALE_MIN_SEED_VOLUME_USD = 1_500;
const NEAR_HIGH_VOLUME_FALLBACK_SEED_VOLUME_FACTOR = 0.6;
const NEAR_HIGH_VOLUME_FALLBACK_SEED_LIQUIDITY_FACTOR = 0.8;
const NEAR_HIGH_VOLUME_FALLBACK_SEED_TX_FACTOR = 0.75;
const NEAR_HIGH_VOLUME_FALLBACK_SEED_AVG_TRADE_FACTOR = 0.85;
const PAPER_WHALE_MIN_AVG_TRADE_USD = 250;
const PAPER_WHALE_FALLBACK_MIN_AVG_TRADE_USD = 400;
const PAPER_WHALE_SPECIALIST_MIN_AVG_TRADE_USD = 500;
const PAPER_WHALE_FALLBACK_MIN_SEED_VOLUME_FACTOR = 1.5;
const PAPER_WHALE_WEAK_SEED_CANDIDATE_VOLUME_FACTOR = 1.35;
const PAPER_WHALE_SPECIALIST_MIN_SEED_SHARE = 0.2;
const PAPER_WHALE_SPECIALIST_MIN_SEED_AVG_TRADE_FACTOR = 1.25;
const HIGH_VOLUME_SEED_DEEP_SCAN_VOLUME_USD = 2_500_000;
const HIGH_VOLUME_SEED_DEEP_SCAN_TX_COUNT = 20_000;
const HIGH_VOLUME_SEED_DEEP_SCAN_CAP = 450;
const HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT = 2;
const HIGH_VOLUME_SEED_MIN_USABLE_CANDIDATES = 2;
const HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_FACTOR = 0.1;
const HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_USD = 1_000;
const HIGH_VOLUME_SEED_POOL_CANDIDATE_MIN_VOLUME_USD = HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_USD;
const HIGH_VOLUME_SEED_WEAK_SIGNAL_SCAN_CAP = 200;
const JUPITER_V4_PROGRAM_ID = 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB';
const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const SCOUT_KNOWN_DEX_PROGRAM_IDS = new Set<string>([
  getPumpProgramId(),
  getPumpAmmProgramId(),
  ...RAYDIUM_AMM_V4_PROGRAM_IDS,
  JUPITER_V4_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
]);
const dexscreenerClient = new DexscreenerClient();
const liquidityScreenService = new LiquidityScreenService();
const scoutSeedCheckCache = new Map<string, { expiresAt: number; value: MigratedSeedCheck }>();
const scoutTokenUsdPriceCache = new Map<string, { expiresAt: number; priceUsd: number | null }>();
const inFlightScoutTokenUsdPriceRequests = new Map<string, Promise<number | null>>();
const limitScoutDirectRpc = createAsyncLimiter(1);
let scoutDirectRpcNextAllowedAt = 0;
let scoutParsedTransactionBatchUnsupported = false;

type ParsedTransactionResponse = Awaited<ReturnType<Connection['getParsedTransaction']>>;
type SignatureInfoResponse = Awaited<ReturnType<Connection['getSignaturesForAddress']>>[number];

type DexBoostToken = {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
};

type ScoutSeedSource = 'boost' | 'market' | 'boost+market';

type RawScoutSeedInput = {
  tokenAddress: string;
  boostWeight: number;
  source: ScoutSeedSource;
  sourceMarketVolume24hUsd: number;
  sourceMarketLiquidityUsd: number;
  sourceMarketTxCount24h: number;
};

type ScoutCandidateStats = {
  estimatedVolumeUsd: number;
  qualifyingTradeCount: number;
  distinctTokenCount: number;
  lookbackHours: number;
  lastTradeAt?: string;
};

type MigratedSeedCheck = {
  eligible: boolean;
  reason: string;
  scanAddress?: string;
};

type SeedTraderCandidate = {
  walletAddress: string;
  tokenVolumeUsd: number;
  tokenTradeCount: number;
  lastTradeAt?: string;
};

type ScoutSeedCandidate = {
  mintAddress: string;
  scanAddress: string;
  source: ScoutSeedSource;
  reason: string;
  boostWeight: number;
  marketPriceUsd: number;
  marketVolume24hUsd: number;
  marketLiquidityUsd: number;
  marketTxCount24h: number;
  marketAvgTradeUsd: number;
  highVolumeEligible: boolean;
};

type RejectedScoutCandidateRecord = {
  address: string;
  rejectUntil: string;
  lastRejectedAt: string;
  lastRejectReason: string;
  estimatedVolumeUsd?: number;
  qualifyingTradeCount?: number;
  distinctTokenCount?: number;
  lastSeedToken?: string;
  seedTokenVolumeUsd?: number;
};

type RejectedScoutCandidateStore = Record<string, RejectedScoutCandidateRecord>;

// Hilfsfunktion für Pausen
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function backOffAfterScoutRateLimit(scope: string) {
  if (env.SCOUT_RATE_LIMIT_COOLDOWN_MS <= 0) {
    return;
  }

  scoutDirectRpcNextAllowedAt = Math.max(
    scoutDirectRpcNextAllowedAt,
    Date.now() + env.SCOUT_RATE_LIMIT_COOLDOWN_MS,
  );
  console.warn(`[SCOUT] RPC-Limit bei ${scope}. Pausiere ${env.SCOUT_RATE_LIMIT_COOLDOWN_MS}ms.`);
  await sleep(env.SCOUT_RATE_LIMIT_COOLDOWN_MS);
}

async function runScoutDirectRpc<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  return limitScoutDirectRpc(async () => {
    const waitMs = Math.max(0, scoutDirectRpcNextAllowedAt - Date.now());
    if (waitMs > 0) {
      console.log(`[SCOUT] RPC-Pacer wartet ${waitMs}ms vor ${scope}.`);
      await sleep(waitMs);
    }

    try {
      return await operation();
    } finally {
      scoutDirectRpcNextAllowedAt = Math.max(
        scoutDirectRpcNextAllowedAt,
        Date.now() + env.SCOUT_RPC_MIN_INTERVAL_MS,
      );
    }
  });
}

async function getSignaturesForAddressWithRetry(
  connection: Connection,
  address: PublicKey,
  options: Parameters<Connection['getSignaturesForAddress']>[1],
) {
  return withRpcRetry(
    () => runScoutDirectRpc(
      `getSignaturesForAddress ${address.toBase58().slice(0, 8)}`,
      () => connection.getSignaturesForAddress(address, options),
    ),
    {
      delaysMs: SCOUT_RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`[SCOUT] RPC Retry getSignaturesForAddress ${address.toBase58().slice(0, 8)} in ${delayMs}ms (${attempt}/${SCOUT_RPC_RETRY_DELAYS_MS.length}).`);
      },
    },
  );
}

function isScoutParsedTransactionBatchUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return normalized.includes('batch requests are only available for paid plans')
    || normalized.includes('batch requests are only available')
    || normalized.includes('does not provide batch support')
    || normalized.includes('does not support batch');
}

async function getParsedTransactionWithRetry(
  connection: Connection,
  signature: string,
): Promise<ParsedTransactionResponse> {
  return withRpcRetry(
    () => runScoutDirectRpc(
      `getParsedTransaction ${signature.slice(0, 8)}`,
      async () => {
        const parsedTx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        return parsedTx;
      },
    ),
    {
      delaysMs: SCOUT_RPC_RETRY_DELAYS_MS,
      onRetry: (delayMs, attempt) => {
        console.warn(`[SCOUT] RPC Retry getParsedTransaction ${signature.slice(0, 8)} in ${delayMs}ms (${attempt}/${SCOUT_RPC_RETRY_DELAYS_MS.length}).`);
      },
    },
  );
}

async function getParsedTransactionsForScout(
  connection: Connection,
  signatures: string[],
  options?: {
    onBatchRetry?: (delayMs: number, attempt: number) => void;
  },
): Promise<Array<ParsedTransactionResponse | null>> {
  if (!scoutParsedTransactionBatchUnsupported) {
    try {
      return await withRpcRetry(
        () => runScoutDirectRpc(
          `getParsedTransactions batch(${signatures.length})`,
          () => connection.getParsedTransactions(signatures, { maxSupportedTransactionVersion: 0 }),
        ),
        {
          delaysMs: SCOUT_RPC_RETRY_DELAYS_MS,
          onRetry: (delayMs, attempt) => {
            options?.onBatchRetry?.(delayMs, attempt);
            console.warn(`[SCOUT] RPC Retry getParsedTransactions batch(${signatures.length}) in ${delayMs}ms (${attempt}/${SCOUT_RPC_RETRY_DELAYS_MS.length}).`);
          },
        },
      );
    } catch (error) {
      if (!isScoutParsedTransactionBatchUnsupportedError(error)) {
        throw error;
      }

      scoutParsedTransactionBatchUnsupported = true;
      console.warn('[SCOUT] RPC-Provider unterstuetzt keine JSON-RPC-Batch-Requests. Wechsle fuer Parsed-TX-Scans auf Einzelabfragen.');
    }
  }

  const parsedTransactions: Array<ParsedTransactionResponse | null> = [];
  for (const signature of signatures) {
    parsedTransactions.push(await getParsedTransactionWithRetry(connection, signature));
  }

  return parsedTransactions;
}

function reduceParsedTxBatchSize(currentBatchSize: number, scope: string): number {
  const nextBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
  if (nextBatchSize < currentBatchSize) {
    console.warn(`[SCOUT] ${scope}: reduziere Parsed-TX-Batch von ${currentBatchSize} auf ${nextBatchSize}.`);
  }

  return nextBatchSize;
}

function getOldestSignatureBlockTime(signatures: SignatureInfoResponse[]): number | null {
  for (let index = signatures.length - 1; index >= 0; index -= 1) {
    const blockTime = signatures[index]?.blockTime;
    if (typeof blockTime === 'number') {
      return blockTime;
    }
  }

  return null;
}

async function collectWalletSignatures(
  connection: Connection,
  walletPubKey: PublicKey,
  walletAddress: string,
  signatureLimit: number,
  cutoffTimestampSec: number,
): Promise<SignatureInfoResponse[] | null> {
  const requestedLimit = Math.max(1, signatureLimit);
  const signatureScanCap = requestedLimit >= env.SCOUT_WHALE_EXTENDED_SIGNATURE_LIMIT
    ? Math.max(requestedLimit, SCOUT_WHALE_ADAPTIVE_SIGNATURE_SCAN_CAP)
    : requestedLimit;
  const pageLimit = Math.max(1, Math.min(env.SCOUT_TOKEN_SIGNATURE_BATCH_LIMIT, signatureScanCap));
  const signatures: SignatureInfoResponse[] = [];
  let beforeSignature: string | undefined;
  let expandedWindow = false;

  while (signatures.length < signatureScanCap) {
    const nextLimit = Math.min(pageLimit, signatureScanCap - signatures.length);

    let nextPage;
    try {
      nextPage = await getSignaturesForAddressWithRetry(connection, walletPubKey, {
        limit: nextLimit,
        ...(beforeSignature ? { before: beforeSignature } : {}),
      });
    } catch (error) {
      if (isSolanaRpcRateLimitError(error)) {
        await backOffAfterScoutRateLimit(`Wallet-Pruefung ${walletAddress.slice(0, 8)} (Signaturen)`);
        return null;
      }

      throw error;
    }

    if (nextPage.length === 0) {
      break;
    }

    signatures.push(...nextPage);
    const oldestBlockTime = getOldestSignatureBlockTime(signatures);
    const coversLookback = typeof oldestBlockTime === 'number' && oldestBlockTime < cutoffTimestampSec;

    if (!expandedWindow && signatures.length >= requestedLimit && signatureScanCap > requestedLimit && !coversLookback) {
      expandedWindow = true;
      const oldestAgeMinutes = typeof oldestBlockTime === 'number'
        ? Math.max(1, Math.round((Date.now() / 1000 - oldestBlockTime) / 60))
        : null;
      console.log(`[SCOUT] Wallet-Pruefung fuer ${walletAddress.slice(0, 8)} erweitert Signaturfenster ueber ${requestedLimit}, da ${env.SCOUT_WHALE_LOOKBACK_HOURS}h noch nicht abgedeckt sind${oldestAgeMinutes ? ` (aelteste Signatur ~${oldestAgeMinutes}m alt)` : ''}.`);
    }

    if (signatures.length >= requestedLimit && coversLookback) {
      break;
    }

    beforeSignature = nextPage.at(-1)?.signature;
    if (!beforeSignature || nextPage.length < nextLimit) {
      break;
    }
  }

  return signatures;
}

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
  const whaleCount = readWhales().length;
  if (whaleCount === 0) {
    return EMPTY_SCOUT_INTERVAL_MS;
  }

  return whaleCount < FAST_SCOUT_WHALE_TARGET ? FAST_SCOUT_INTERVAL_MS : DEFAULT_SCOUT_INTERVAL_MS;
}

function logNextScoutRun() {
  const whaleCount = readWhales().length;
  const intervalMs = getScoutIntervalMs();
  const intervalMinutes = Math.round(intervalMs / 60_000);
  const intervalLabel = intervalMs < 60_000
    ? `${Math.round(intervalMs / 1000)} Sekunden`
    : `${intervalMinutes} Minuten`;
  const modeLabel = whaleCount === 0 ? 'keine gespeicherten Kandidaten' : `Whales: ${whaleCount}/${FAST_SCOUT_WHALE_TARGET}`;
  console.log(`[SCOUT] Naechster Lauf in ${intervalLabel} (${modeLabel}).`);
}

function getBoostWeight(token: DexBoostToken): number {
  const totalAmount = Number(token.totalAmount);
  if (Number.isFinite(totalAmount) && totalAmount > 0) {
    return totalAmount;
  }

  const amount = Number(token.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

function getBestDexPriceUsd(
  pairs: DexPairSummary[],
  options?: { minLiquidityUsd?: number; requireSolana?: boolean },
): number | null {
  const minLiquidityUsd = options?.minLiquidityUsd ?? 0;
  const requireSolana = options?.requireSolana ?? false;
  const bestPair = [...pairs]
    .filter((pair) => (!requireSolana || pair.chainId === 'solana')
      && Number.isFinite(Number(pair.priceUsd))
      && Number(pair.priceUsd) > 0
      && getPairLiquidityUsd(pair) >= minLiquidityUsd)
    .sort((left, right) => (Number(right.liquidity?.usd) || 0) - (Number(left.liquidity?.usd) || 0))[0];

  if (!bestPair) {
    return null;
  }

  const priceUsd = Number(bestPair.priceUsd);
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
}

function toFiniteNumber(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function getPairLiquidityUsd(pair: DexPairSummary | null | undefined): number {
  return pair ? toFiniteNumber(pair.liquidity?.usd) : 0;
}

function getPairVolume24hUsd(pair: DexPairSummary | null | undefined): number {
  return pair ? toFiniteNumber(pair.volume?.h24) : 0;
}

function getPairTxCount24h(pair: DexPairSummary | null | undefined): number {
  if (!pair) {
    return 0;
  }

  return Math.max(0, Math.round(toFiniteNumber(pair.txns?.h24?.buys) + toFiniteNumber(pair.txns?.h24?.sells)));
}

function getAverageTradeUsd(volumeUsd: number, txCount: number): number {
  if (txCount <= 0) {
    return 0;
  }

  return volumeUsd / txCount;
}

function getPairAverageTradeUsd(pair: DexPairSummary | null | undefined): number {
  return getAverageTradeUsd(getPairVolume24hUsd(pair), getPairTxCount24h(pair));
}

function getPairPriceUsd(pair: DexPairSummary | null | undefined): number {
  return pair ? toFiniteNumber(pair.priceUsd) : 0;
}

function compareSeedMarketQuality(
  left: Pick<RawScoutSeedInput, 'sourceMarketVolume24hUsd' | 'sourceMarketLiquidityUsd' | 'sourceMarketTxCount24h' | 'boostWeight'>,
  right: Pick<RawScoutSeedInput, 'sourceMarketVolume24hUsd' | 'sourceMarketLiquidityUsd' | 'sourceMarketTxCount24h' | 'boostWeight'>,
): number {
  const avgTradeDiff = getAverageTradeUsd(right.sourceMarketVolume24hUsd, right.sourceMarketTxCount24h)
    - getAverageTradeUsd(left.sourceMarketVolume24hUsd, left.sourceMarketTxCount24h);
  if (avgTradeDiff !== 0) {
    return avgTradeDiff;
  }

  const volumeDiff = right.sourceMarketVolume24hUsd - left.sourceMarketVolume24hUsd;
  if (volumeDiff !== 0) {
    return volumeDiff;
  }

  const liquidityDiff = right.sourceMarketLiquidityUsd - left.sourceMarketLiquidityUsd;
  if (liquidityDiff !== 0) {
    return liquidityDiff;
  }

  const txDiff = right.sourceMarketTxCount24h - left.sourceMarketTxCount24h;
  if (txDiff !== 0) {
    return txDiff;
  }

  return right.boostWeight - left.boostWeight;
}

function getScoutSeedSourceLabel(hasBoost: boolean, hasMarket: boolean): ScoutSeedSource {
  if (hasBoost && hasMarket) {
    return 'boost+market';
  }

  if (hasMarket) {
    return 'market';
  }

  return 'boost';
}

function getNonSolTokenAddress(pair: DexPairSummary): string | null {
  const baseAddress = pair.baseToken?.address;
  const quoteAddress = pair.quoteToken?.address;

  if (baseAddress && baseAddress !== SOL_MINT && quoteAddress === SOL_MINT) {
    return baseAddress;
  }

  if (quoteAddress && quoteAddress !== SOL_MINT && baseAddress === SOL_MINT) {
    return quoteAddress;
  }

  if (baseAddress && baseAddress !== SOL_MINT) {
    return baseAddress;
  }

  if (quoteAddress && quoteAddress !== SOL_MINT) {
    return quoteAddress;
  }

  return null;
}

function normalizeScoutDexId(dexId?: string): string | undefined {
  const normalized = dexId?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isSupportedScoutMarketDexId(dexId?: string): boolean {
  const normalized = normalizeScoutDexId(dexId);
  return normalized === 'pumpfun-amm'
    || normalized === 'pumpswap'
    || (normalized?.includes('raydium') ?? false)
    || (normalized?.includes('orca') ?? false);
}

function isSupportedScoutMarketPair(pair: DexPairSummary): boolean {
  return pair.chainId === 'solana'
    && isSupportedScoutMarketDexId(pair.dexId)
    && typeof pair.pairAddress === 'string'
    && pair.pairAddress.trim().length > 0
    && getNonSolTokenAddress(pair) !== null;
}

function qualifiesAsHighVolumeRawSeed(input: RawScoutSeedInput): boolean {
  return qualifiesAsHighVolumeSeed({
    marketVolume24hUsd: input.sourceMarketVolume24hUsd,
    marketLiquidityUsd: input.sourceMarketLiquidityUsd,
    marketTxCount24h: input.sourceMarketTxCount24h,
    marketAvgTradeUsd: getAverageTradeUsd(input.sourceMarketVolume24hUsd, input.sourceMarketTxCount24h),
  });
}

function isScoutPairMatch(pair: DexPairSummary, mintAddress: string): boolean {
  return pair.chainId === 'solana'
    && (pair.baseToken?.address === mintAddress || pair.quoteToken?.address === mintAddress);
}

function pickBestScoutSeedPair(mintAddress: string, pairs: DexPairSummary[]): DexPairSummary | null {
  const matchingPairs = pairs.filter((pair) => isScoutPairMatch(pair, mintAddress) && isSupportedScoutMarketDexId(pair.dexId));
  if (matchingPairs.length === 0) {
    return null;
  }

  return [...matchingPairs].sort((left, right) => {
    const volumeDiff = getPairVolume24hUsd(right) - getPairVolume24hUsd(left);
    if (volumeDiff !== 0) {
      return volumeDiff;
    }

    const liquidityDiff = getPairLiquidityUsd(right) - getPairLiquidityUsd(left);
    if (liquidityDiff !== 0) {
      return liquidityDiff;
    }

    return getPairTxCount24h(right) - getPairTxCount24h(left);
  })[0] ?? null;
}

function qualifiesAsHighVolumeSeed(seed: Pick<ScoutSeedCandidate, 'marketVolume24hUsd' | 'marketLiquidityUsd' | 'marketTxCount24h' | 'marketAvgTradeUsd'>): boolean {
  return seed.marketVolume24hUsd >= env.SCOUT_MIN_SEED_VOLUME_USD
    && seed.marketLiquidityUsd >= env.SCOUT_MIN_SEED_LIQUIDITY_USD
    && seed.marketTxCount24h >= env.SCOUT_MIN_SEED_TX_COUNT
    && seed.marketAvgTradeUsd >= env.SCOUT_MIN_SEED_AVG_TRADE_USD;
}

function getCachedMigratedScoutSeed(mintAddress: string): MigratedSeedCheck | null {
  const cached = scoutSeedCheckCache.get(mintAddress);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    scoutSeedCheckCache.delete(mintAddress);
    return null;
  }

  return cached.value;
}

function setCachedMigratedScoutSeed(mintAddress: string, value: MigratedSeedCheck) {
  scoutSeedCheckCache.set(mintAddress, {
    expiresAt: Date.now() + SCOUT_SEED_CHECK_CACHE_TTL_MS,
    value,
  });
}

function getCachedTokenUsdPrice(mintAddress: string): number | null | undefined {
  const cached = scoutTokenUsdPriceCache.get(mintAddress);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    scoutTokenUsdPriceCache.delete(mintAddress);
    return undefined;
  }

  return cached.priceUsd;
}

function setCachedTokenUsdPrice(mintAddress: string, priceUsd: number | null) {
  scoutTokenUsdPriceCache.set(mintAddress, {
    expiresAt: Date.now() + SCOUT_TOKEN_PRICE_CACHE_TTL_MS,
    priceUsd,
  });
}

async function fetchTokenUsdPrice(mintAddress: string): Promise<number | null> {
  const cached = getCachedTokenUsdPrice(mintAddress);
  if (cached !== undefined) {
    return cached;
  }

  const inFlight = inFlightScoutTokenUsdPriceRequests.get(mintAddress);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    try {
      const priceUsd = getBestDexPriceUsd(await dexscreenerClient.searchTokenPairs(mintAddress), {
        minLiquidityUsd: SCOUT_MIN_TOKEN_PRICE_LIQUIDITY_USD,
        requireSolana: true,
      });
      const resolvedPriceUsd = priceUsd && priceUsd > 0 ? priceUsd : null;
      setCachedTokenUsdPrice(mintAddress, resolvedPriceUsd);
      return resolvedPriceUsd;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[SCOUT] Token-Preis fuer ${mintAddress.slice(0, 8)} konnte nicht geladen werden: ${message}`);
      setCachedTokenUsdPrice(mintAddress, null);
      return null;
    }
  })().finally(() => {
    inFlightScoutTokenUsdPriceRequests.delete(mintAddress);
  });

  inFlightScoutTokenUsdPriceRequests.set(mintAddress, request);
  return request;
}

async function fetchBoostScoutSeedInputs(): Promise<RawScoutSeedInput[]> {
  const response = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
  if (!response.ok) {
    throw new Error(`Dexscreener token boosts request failed with ${response.status}`);
  }

  const rawTokens = await response.json();
  const tokens = Array.isArray(rawTokens) ? rawTokens as DexBoostToken[] : [];

  return tokens
    .filter((token): token is DexBoostToken & { tokenAddress: string } => token.chainId === 'solana' && isLikelySolanaMintAddress(token.tokenAddress))
    .sort((left, right) => getBoostWeight(right) - getBoostWeight(left))
    .slice(0, env.SCOUT_BOOST_SCAN_LIMIT)
    .map((token) => ({
      tokenAddress: token.tokenAddress,
      boostWeight: getBoostWeight(token),
      source: 'boost' as const,
      sourceMarketVolume24hUsd: 0,
      sourceMarketLiquidityUsd: 0,
      sourceMarketTxCount24h: 0,
    }));
}

async function fetchMarketScoutSeedInputs(): Promise<RawScoutSeedInput[]> {
  const marketQueries = ['pump', 'pumpswap', 'raydium', 'orca'];
  const settledResults = await Promise.allSettled(marketQueries.map((query) => dexscreenerClient.searchPairs(query)));
  const candidates = new Map<string, RawScoutSeedInput>();

  for (const result of settledResults) {
    if (result.status !== 'fulfilled') {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[SCOUT] Dexscreener Markt-Seed-Suche fehlgeschlagen: ${message}`);
      continue;
    }

    for (const pair of result.value) {
      if (!isSupportedScoutMarketPair(pair)) {
        continue;
      }

      const tokenAddress = getNonSolTokenAddress(pair);
      if (!tokenAddress || !isLikelySolanaMintAddress(tokenAddress)) {
        continue;
      }

      const nextCandidate: RawScoutSeedInput = {
        tokenAddress,
        boostWeight: 0,
        source: 'market',
        sourceMarketVolume24hUsd: getPairVolume24hUsd(pair),
        sourceMarketLiquidityUsd: getPairLiquidityUsd(pair),
        sourceMarketTxCount24h: getPairTxCount24h(pair),
      };
      const existing = candidates.get(tokenAddress);
      if (!existing || compareSeedMarketQuality(existing, nextCandidate) > 0) {
        candidates.set(tokenAddress, nextCandidate);
      }
    }
  }

  const rankedCandidates = [...candidates.values()].sort(compareSeedMarketQuality);
  const highVolumeCandidates = rankedCandidates.filter(qualifiesAsHighVolumeRawSeed);
  return (highVolumeCandidates.length > 0 ? highVolumeCandidates : rankedCandidates)
    .slice(0, env.SCOUT_MARKET_TOKEN_LIMIT);
}

function mergeScoutSeedInputs(
  boostInputs: RawScoutSeedInput[],
  marketInputs: RawScoutSeedInput[],
): RawScoutSeedInput[] {
  const mergedInputs = new Map<string, RawScoutSeedInput>();

  for (const input of [...boostInputs, ...marketInputs]) {
    const existing = mergedInputs.get(input.tokenAddress);
    if (!existing) {
      mergedInputs.set(input.tokenAddress, { ...input });
      continue;
    }

    const merged: RawScoutSeedInput = {
      tokenAddress: input.tokenAddress,
      boostWeight: Math.max(existing.boostWeight, input.boostWeight),
      source: getScoutSeedSourceLabel(
        existing.source === 'boost' || existing.source === 'boost+market' || input.source === 'boost' || input.source === 'boost+market',
        existing.source === 'market' || existing.source === 'boost+market' || input.source === 'market' || input.source === 'boost+market',
      ),
      sourceMarketVolume24hUsd: Math.max(existing.sourceMarketVolume24hUsd, input.sourceMarketVolume24hUsd),
      sourceMarketLiquidityUsd: Math.max(existing.sourceMarketLiquidityUsd, input.sourceMarketLiquidityUsd),
      sourceMarketTxCount24h: Math.max(existing.sourceMarketTxCount24h, input.sourceMarketTxCount24h),
    };

    mergedInputs.set(input.tokenAddress, merged);
  }

  return [...mergedInputs.values()].sort(compareSeedMarketQuality);
}

function normalizeRejectedCandidateStore(input: unknown): RejectedScoutCandidateStore {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const normalized: RejectedScoutCandidateStore = {};
  for (const [address, value] of Object.entries(input as Record<string, unknown>)) {
    try {
      new PublicKey(address);
    } catch {
      continue;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const candidate = value as Record<string, unknown>;
    const rejectUntil = typeof candidate.rejectUntil === 'string' ? candidate.rejectUntil : undefined;
    if (!rejectUntil || !Number.isFinite(Date.parse(rejectUntil))) {
      continue;
    }

    normalized[address] = {
      address,
      rejectUntil,
      lastRejectedAt: typeof candidate.lastRejectedAt === 'string' ? candidate.lastRejectedAt : rejectUntil,
      lastRejectReason: typeof candidate.lastRejectReason === 'string' ? candidate.lastRejectReason : 'unknown',
      ...(Number.isFinite(Number(candidate.estimatedVolumeUsd)) ? { estimatedVolumeUsd: Number(candidate.estimatedVolumeUsd) } : {}),
      ...(Number.isFinite(Number(candidate.qualifyingTradeCount)) ? { qualifyingTradeCount: Number(candidate.qualifyingTradeCount) } : {}),
      ...(Number.isFinite(Number(candidate.distinctTokenCount)) ? { distinctTokenCount: Number(candidate.distinctTokenCount) } : {}),
      ...(typeof candidate.lastSeedToken === 'string' ? { lastSeedToken: candidate.lastSeedToken } : {}),
      ...(Number.isFinite(Number(candidate.seedTokenVolumeUsd)) ? { seedTokenVolumeUsd: Number(candidate.seedTokenVolumeUsd) } : {}),
    };
  }

  return normalized;
}

function readRejectedCandidateStore(): RejectedScoutCandidateStore {
  return normalizeRejectedCandidateStore(readJsonFileSync(SCOUT_CANDIDATE_CACHE_FILE, {}));
}

function writeRejectedCandidateStore(store: RejectedScoutCandidateStore) {
  writeJsonFileSync(SCOUT_CANDIDATE_CACHE_FILE, store);
}

function pruneRejectedCandidateStore(store: RejectedScoutCandidateStore, nowMs = Date.now()): boolean {
  let dirty = false;

  for (const [address, record] of Object.entries(store)) {
    const rejectUntilMs = Date.parse(record.rejectUntil);
    if (!Number.isFinite(rejectUntilMs) || rejectUntilMs <= nowMs) {
      delete store[address];
      dirty = true;
    }
  }

  return dirty;
}

function isCandidateCoolingDown(store: RejectedScoutCandidateStore, address: string, nowMs = Date.now()): boolean {
  const rejectUntil = store[address]?.rejectUntil;
  if (!rejectUntil) {
    return false;
  }

  const rejectUntilMs = Date.parse(rejectUntil);
  return Number.isFinite(rejectUntilMs) && rejectUntilMs > nowMs;
}

function rememberRejectedCandidate(
  store: RejectedScoutCandidateStore,
  walletAddress: string,
  rejectReason: string,
  stats: ScoutCandidateStats,
  mintAddress: string,
  trader: SeedTraderCandidate,
) {
  const rejectedAt = new Date();
  store[walletAddress] = {
    address: walletAddress,
    lastRejectedAt: rejectedAt.toISOString(),
    rejectUntil: new Date(rejectedAt.getTime() + env.SCOUT_REJECT_COOLDOWN_MINUTES * 60_000).toISOString(),
    lastRejectReason: rejectReason,
    estimatedVolumeUsd: Math.round(getCandidateEffectiveVolumeUsd(stats, trader)),
    qualifyingTradeCount: stats.qualifyingTradeCount,
    distinctTokenCount: stats.distinctTokenCount,
    lastSeedToken: mintAddress,
    seedTokenVolumeUsd: Math.round(trader.tokenVolumeUsd),
  };
}

function clearRejectedCandidate(store: RejectedScoutCandidateStore, walletAddress: string): boolean {
  if (!(walletAddress in store)) {
    return false;
  }

  delete store[walletAddress];
  return true;
}

function getCandidateEffectiveVolumeUsd(stats: ScoutCandidateStats, trader?: SeedTraderCandidate): number {
  return Math.max(stats.estimatedVolumeUsd, trader?.tokenVolumeUsd ?? 0, 0);
}

function getCandidateSeedShare(stats: ScoutCandidateStats, trader: SeedTraderCandidate): number {
  const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(stats, trader);
  if (effectiveVolumeUsd <= 0 || trader.tokenVolumeUsd <= 0) {
    return 0;
  }

  return Math.min(1, trader.tokenVolumeUsd / effectiveVolumeUsd);
}

function buildWhaleRejectReason(stats: ScoutCandidateStats, trader?: SeedTraderCandidate): string {
  const reasons: string[] = [];
  const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(stats, trader);

  if (effectiveVolumeUsd < env.SCOUT_MIN_WHALE_VOLUME_USD) {
    reasons.push(`volume ${effectiveVolumeUsd.toFixed(0)}/${env.SCOUT_MIN_WHALE_VOLUME_USD}`);
  }

  if (stats.qualifyingTradeCount < env.SCOUT_MIN_WHALE_TX_COUNT) {
    reasons.push(`trades ${stats.qualifyingTradeCount}/${env.SCOUT_MIN_WHALE_TX_COUNT}`);
  }

  if (stats.distinctTokenCount < env.SCOUT_MIN_WHALE_DISTINCT_TOKENS) {
    reasons.push(`tokens ${stats.distinctTokenCount}/${env.SCOUT_MIN_WHALE_DISTINCT_TOKENS}`);
  }

  return reasons.join(', ');
}

function getCandidateAverageTradeUsd(stats: ScoutCandidateStats, trader?: SeedTraderCandidate): number {
  if (stats.qualifyingTradeCount <= 0) {
    return 0;
  }

  return getCandidateEffectiveVolumeUsd(stats, trader) / stats.qualifyingTradeCount;
}

function getPaperWhaleAvgTradeFloorUsd(): number {
  return Math.max(
    PAPER_WHALE_MIN_AVG_TRADE_USD,
    env.SCOUT_MIN_SEED_AVG_TRADE_USD * 2,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * 0.25,
  );
}

function getFallbackPaperWhaleAvgTradeFloorUsd(): number {
  return Math.max(
    PAPER_WHALE_FALLBACK_MIN_AVG_TRADE_USD,
    getPaperWhaleAvgTradeFloorUsd() * 1.6,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * 0.4,
  );
}

function getSpecialistPaperWhaleAvgTradeFloorUsd(): number {
  return Math.max(
    PAPER_WHALE_SPECIALIST_MIN_AVG_TRADE_USD,
    getPaperWhaleAvgTradeFloorUsd() * 2,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * 0.5,
  );
}

function qualifiesAsNearHighVolumeFallbackSeed(seed: ScoutSeedCandidate): boolean {
  const fallbackVolumeFloor = Math.max(
    50_000,
    env.SCOUT_MIN_SEED_VOLUME_USD * NEAR_HIGH_VOLUME_FALLBACK_SEED_VOLUME_FACTOR,
  );
  const fallbackLiquidityFloor = Math.max(
    15_000,
    env.SCOUT_MIN_SEED_LIQUIDITY_USD * NEAR_HIGH_VOLUME_FALLBACK_SEED_LIQUIDITY_FACTOR,
  );
  const fallbackTxFloor = Math.max(
    60,
    Math.floor(env.SCOUT_MIN_SEED_TX_COUNT * NEAR_HIGH_VOLUME_FALLBACK_SEED_TX_FACTOR),
  );
  const fallbackAvgTradeFloor = Math.max(
    100,
    env.SCOUT_MIN_SEED_AVG_TRADE_USD * NEAR_HIGH_VOLUME_FALLBACK_SEED_AVG_TRADE_FACTOR,
  );

  return seed.marketVolume24hUsd >= fallbackVolumeFloor
    && seed.marketLiquidityUsd >= fallbackLiquidityFloor
    && seed.marketTxCount24h >= fallbackTxFloor
    && seed.marketAvgTradeUsd >= fallbackAvgTradeFloor;
}

function qualifiesAsEstablishedPaperWhale(
  stats: ScoutCandidateStats,
  trader: SeedTraderCandidate,
  seed: ScoutSeedCandidate,
): boolean {
  const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(stats, trader);

  if (!qualifiesAsEstablishedWhale(stats, trader)) {
    return false;
  }

  const avgTradeUsd = getCandidateAverageTradeUsd(stats, trader);
  const standardAvgTradeFloor = getPaperWhaleAvgTradeFloorUsd();
  if (avgTradeUsd < standardAvgTradeFloor) {
    return false;
  }

  if (!seed.highVolumeEligible) {
    return stats.distinctTokenCount >= (env.SCOUT_MIN_WHALE_DISTINCT_TOKENS + 1)
      && trader.tokenVolumeUsd >= Math.max(
        SPECIALIST_WHALE_MIN_SEED_VOLUME_USD,
        env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * PAPER_WHALE_FALLBACK_MIN_SEED_VOLUME_FACTOR,
      )
      && avgTradeUsd >= getFallbackPaperWhaleAvgTradeFloorUsd();
  }

  if (trader.tokenVolumeUsd < env.SCOUT_MIN_SEED_TRADER_VOLUME_USD) {
    return effectiveVolumeUsd >= (env.SCOUT_MIN_WHALE_VOLUME_USD * PAPER_WHALE_WEAK_SEED_CANDIDATE_VOLUME_FACTOR)
      && stats.qualifyingTradeCount >= (env.SCOUT_MIN_WHALE_TX_COUNT + 1)
      && avgTradeUsd >= getFallbackPaperWhaleAvgTradeFloorUsd();
  }

  if (stats.distinctTokenCount <= env.SCOUT_MIN_WHALE_DISTINCT_TOKENS && avgTradeUsd < (standardAvgTradeFloor * 1.5)) {
    return false;
  }

  return true;
}

function buildPaperWhaleRejectReason(
  stats: ScoutCandidateStats,
  trader: SeedTraderCandidate,
  seed: ScoutSeedCandidate,
): string {
  const reasons: string[] = [];
  const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(stats, trader);
  const baseReason = buildWhaleRejectReason(stats, trader);
  if (baseReason) {
    reasons.push(baseReason);
  }

  const avgTradeUsd = getCandidateAverageTradeUsd(stats, trader);
  const avgTradeFloor = (!seed.highVolumeEligible || trader.tokenVolumeUsd < env.SCOUT_MIN_SEED_TRADER_VOLUME_USD)
    ? getFallbackPaperWhaleAvgTradeFloorUsd()
    : getPaperWhaleAvgTradeFloorUsd();
  if (avgTradeUsd < avgTradeFloor) {
    reasons.push(`avgTrade ${avgTradeUsd.toFixed(0)}/${avgTradeFloor.toFixed(0)}`);
  }

  const narrowWalletAvgTradeFloor = getPaperWhaleAvgTradeFloorUsd() * 1.5;
  if (seed.highVolumeEligible
    && trader.tokenVolumeUsd >= env.SCOUT_MIN_SEED_TRADER_VOLUME_USD
    && stats.distinctTokenCount <= env.SCOUT_MIN_WHALE_DISTINCT_TOKENS
    && avgTradeUsd < narrowWalletAvgTradeFloor) {
    reasons.push(`narrow-wallet avgTrade ${avgTradeUsd.toFixed(0)}/${narrowWalletAvgTradeFloor.toFixed(0)}`);
  }

  if (!seed.highVolumeEligible && stats.distinctTokenCount < (env.SCOUT_MIN_WHALE_DISTINCT_TOKENS + 1)) {
    reasons.push(`fallback-tokens ${stats.distinctTokenCount}/${env.SCOUT_MIN_WHALE_DISTINCT_TOKENS + 1}`);
  }

  if (!seed.highVolumeEligible && trader.tokenVolumeUsd < Math.max(
    SPECIALIST_WHALE_MIN_SEED_VOLUME_USD,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * PAPER_WHALE_FALLBACK_MIN_SEED_VOLUME_FACTOR,
  )) {
    reasons.push(`fallback-seed-volume ${trader.tokenVolumeUsd.toFixed(0)}/${Math.max(
      SPECIALIST_WHALE_MIN_SEED_VOLUME_USD,
      env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * PAPER_WHALE_FALLBACK_MIN_SEED_VOLUME_FACTOR,
    ).toFixed(0)}`);
  }

  if (seed.highVolumeEligible && trader.tokenVolumeUsd < env.SCOUT_MIN_SEED_TRADER_VOLUME_USD) {
    const strongerVolumeFloor = env.SCOUT_MIN_WHALE_VOLUME_USD * PAPER_WHALE_WEAK_SEED_CANDIDATE_VOLUME_FACTOR;
    if (effectiveVolumeUsd < strongerVolumeFloor) {
      reasons.push(`fallback-volume ${effectiveVolumeUsd.toFixed(0)}/${strongerVolumeFloor.toFixed(0)}`);
    }

    const strongerTradeFloor = env.SCOUT_MIN_WHALE_TX_COUNT + 1;
    if (stats.qualifyingTradeCount < strongerTradeFloor) {
      reasons.push(`fallback-trades ${stats.qualifyingTradeCount}/${strongerTradeFloor}`);
    }
  }

  const specialistVolumeFloor = Math.max(
    SPECIALIST_WHALE_MIN_VOLUME_USD,
    env.SCOUT_MIN_WHALE_VOLUME_USD * SPECIALIST_WHALE_VOLUME_FACTOR,
  );
  const specialistTradeFloor = Math.max(
    env.SCOUT_MIN_WHALE_TX_COUNT + 2,
    env.SCOUT_MIN_WHALE_TX_COUNT * SPECIALIST_WHALE_MIN_TRADE_MULTIPLIER,
  );
  const specialistSeedVolumeFloor = Math.max(
    SPECIALIST_WHALE_MIN_SEED_VOLUME_USD,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * 2,
  );
  const specialistSeedShare = getCandidateSeedShare(stats, trader);
  if (seed.highVolumeEligible
    && effectiveVolumeUsd >= specialistVolumeFloor
    && stats.qualifyingTradeCount >= specialistTradeFloor
    && trader.tokenVolumeUsd >= specialistSeedVolumeFloor
    && avgTradeUsd >= getSpecialistPaperWhaleAvgTradeFloorUsd()
    && specialistSeedShare < PAPER_WHALE_SPECIALIST_MIN_SEED_SHARE) {
    reasons.push(`specialist-seed-share ${(specialistSeedShare * 100).toFixed(0)}/${(PAPER_WHALE_SPECIALIST_MIN_SEED_SHARE * 100).toFixed(0)}%`);
  }

  return reasons.join(', ') || 'quality gate';
}

function shouldDeepScanCandidate(stats: ScoutCandidateStats, trader: SeedTraderCandidate): boolean {
  if (stats.estimatedVolumeUsd <= 0) {
    return false;
  }

  const tradeTrigger = Math.max(4, Math.floor(env.SCOUT_MIN_WHALE_TX_COUNT / 2));
  const strongQuickVolumeSignal = stats.estimatedVolumeUsd >= env.SCOUT_DEEP_SCAN_TRIGGER_VOLUME_USD;
  const strongSeedVolumeSignal = trader.tokenVolumeUsd >= env.SCOUT_DEEP_SCAN_TRIGGER_VOLUME_USD
    && stats.estimatedVolumeUsd >= SCOUT_DEEP_SCAN_MIN_QUICK_VOLUME_FOR_STRONG_SEED_USD;
  if (strongQuickVolumeSignal || strongSeedVolumeSignal) {
    return true;
  }

  const tradeSignal = stats.qualifyingTradeCount >= tradeTrigger
    || trader.tokenTradeCount >= tradeTrigger;
  if (!tradeSignal) {
    return false;
  }

  const quickVolumeFloor = Math.max(
    SCOUT_DEEP_SCAN_MIN_QUICK_VOLUME_USD,
    env.SCOUT_DEEP_SCAN_TRIGGER_VOLUME_USD * 0.8,
  );
  const seedVolumeFloor = Math.max(
    SCOUT_DEEP_SCAN_MIN_SEED_VOLUME_USD,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * 0.5,
  );
  const moderateSeedVolumeSignal = trader.tokenVolumeUsd >= seedVolumeFloor
    && stats.estimatedVolumeUsd >= SCOUT_DEEP_SCAN_MIN_QUICK_VOLUME_FOR_STRONG_SEED_USD;

  return stats.estimatedVolumeUsd >= quickVolumeFloor
    || moderateSeedVolumeSignal;
}

function shouldExtendedScanCandidate(stats: ScoutCandidateStats, trader: SeedTraderCandidate): boolean {
  const nearVolumeFloor = Math.max(10_000, env.SCOUT_MIN_WHALE_VOLUME_USD * 0.7);
  const nearTradeFloor = Math.max(1, env.SCOUT_MIN_WHALE_TX_COUNT - 1);
  const nearTokenFloor = Math.max(1, env.SCOUT_MIN_WHALE_DISTINCT_TOKENS);

  return stats.estimatedVolumeUsd >= nearVolumeFloor
    && (
      stats.qualifyingTradeCount >= nearTradeFloor
      || stats.distinctTokenCount >= nearTokenFloor
      || trader.tokenVolumeUsd >= env.SCOUT_MIN_SEED_TRADER_VOLUME_USD
    );
}

function getAccountKeyString(accountKey: unknown): string | undefined {
  if (!accountKey) {
    return undefined;
  }

  if (typeof accountKey === 'string') {
    return accountKey;
  }

  if (typeof accountKey === 'object' && accountKey !== null) {
    const maybePubkey = 'pubkey' in accountKey ? (accountKey as { pubkey?: unknown }).pubkey : accountKey;
    if (typeof maybePubkey === 'string') {
      return maybePubkey;
    }

    if (typeof maybePubkey === 'object' && maybePubkey !== null && 'toBase58' in maybePubkey) {
      const toBase58 = (maybePubkey as { toBase58?: () => string }).toBase58;
      if (typeof toBase58 === 'function') {
        return toBase58.call(maybePubkey);
      }
    }
  }

  return undefined;
}

function getSignerAddress(parsedTx: ParsedTransactionResponse): string | null {
  const accountKeys = (parsedTx?.transaction.message as { accountKeys?: unknown[] } | undefined)?.accountKeys ?? [];
  const signerAccount = accountKeys.find((accountKey) => (
    typeof accountKey === 'object'
      && accountKey !== null
      && 'signer' in accountKey
      && Boolean((accountKey as { signer?: unknown }).signer)
  ));

  if (!signerAccount || typeof signerAccount !== 'object' || signerAccount === null) {
    return null;
  }

  return getAccountKeyString(('pubkey' in signerAccount)
    ? (signerAccount as { pubkey?: unknown }).pubkey
    : signerAccount) ?? null;
}

function getWalletNativeSolDelta(parsedTx: ParsedTransactionResponse, walletAddress: string): number | null {
  const accountKeys = (parsedTx?.transaction.message as { accountKeys?: unknown[] } | undefined)?.accountKeys;
  const walletIndex = accountKeys?.findIndex((accountKey) => getAccountKeyString(accountKey) === walletAddress) ?? -1;

  if (walletIndex < 0) {
    return null;
  }

  const preBalance = parsedTx?.meta?.preBalances?.[walletIndex];
  const postBalance = parsedTx?.meta?.postBalances?.[walletIndex];
  if (preBalance === undefined || postBalance === undefined) {
    return null;
  }

  return lamportsToSol(postBalance - preBalance);
}

function getWalletTokenDeltaUi(parsedTx: ParsedTransactionResponse, walletAddress: string, mint: string): number | null {
  const postBalances = parsedTx?.meta?.postTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];
  const preBalances = parsedTx?.meta?.preTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];

  const postRaw = postBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const preRaw = preBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const deltaRaw = postRaw - preRaw;
  if (deltaRaw === 0n) {
    return null;
  }

  const decimals = postBalances[0]?.uiTokenAmount.decimals ?? preBalances[0]?.uiTokenAmount.decimals ?? 0;
  return Number(deltaRaw < 0n ? -deltaRaw : deltaRaw) / 10 ** decimals;
}

function getWalletSignedTokenDeltaUi(parsedTx: ParsedTransactionResponse, walletAddress: string, mint: string): number | null {
  const postBalances = parsedTx?.meta?.postTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];
  const preBalances = parsedTx?.meta?.preTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];

  const postRaw = postBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const preRaw = preBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const deltaRaw = postRaw - preRaw;
  if (deltaRaw === 0n) {
    return null;
  }

  const decimals = postBalances[0]?.uiTokenAmount.decimals ?? preBalances[0]?.uiTokenAmount.decimals ?? 0;
  const absoluteUi = Number(deltaRaw < 0n ? -deltaRaw : deltaRaw) / 10 ** decimals;
  return deltaRaw < 0n ? -absoluteUi : absoluteUi;
}

function getWalletSolExposure(parsedTx: ParsedTransactionResponse, walletAddress: string): number {
  const nativeSolExposure = Math.abs(getWalletNativeSolDelta(parsedTx, walletAddress) ?? 0);
  const wrappedSolExposure = getWalletTokenDeltaUi(parsedTx, walletAddress, SOL_MINT) ?? 0;
  return Math.max(nativeSolExposure, wrappedSolExposure);
}

function estimateSolExposureUsd(parsedTx: ParsedTransactionResponse, walletAddress: string, solUsdPrice: number): number {
  const solExposure = getWalletSolExposure(parsedTx, walletAddress);
  return solExposure > 0 ? solExposure * solUsdPrice : 0;
}

function estimateSeedTradeVolumeUsd(
  parsedTx: ParsedTransactionResponse,
  walletAddress: string,
  mintAddress: string,
  solUsdPrice: number,
  tokenPriceUsd: number | null,
): number {
  const solExposureUsd = estimateSolExposureUsd(parsedTx, walletAddress, solUsdPrice);
  const tokenDeltaUi = getWalletTokenDeltaUi(parsedTx, walletAddress, mintAddress) ?? 0;
  const tokenExposureUsd = tokenPriceUsd && tokenPriceUsd > 0
    ? tokenDeltaUi * tokenPriceUsd
    : 0;

  return Math.max(solExposureUsd, tokenExposureUsd);
}

async function estimateWalletTradeVolumeUsd(
  parsedTx: ParsedTransactionResponse,
  walletAddress: string,
  tradedMints: string[],
  solUsdPrice: number,
): Promise<number> {
  const uniqueMints = [...new Set(tradedMints)];
  const solExposureUsd = estimateSolExposureUsd(parsedTx, walletAddress, solUsdPrice);
  const hasReliableSolExposure = getWalletSolExposure(parsedTx, walletAddress) >= MIN_RELIABLE_SCOUT_SOL_DELTA;
  if (!hasReliableSolExposure && (uniqueMints.length < 2 || !hasKnownDexProgram(parsedTx))) {
    return 0;
  }

  let maxIncomingTokenExposureUsd = 0;
  let maxOutgoingTokenExposureUsd = 0;

  for (const mint of uniqueMints) {
    const tokenDeltaUi = getWalletSignedTokenDeltaUi(parsedTx, walletAddress, mint);
    if (!tokenDeltaUi || tokenDeltaUi === 0) {
      continue;
    }

    const tokenPriceUsd = await fetchTokenUsdPrice(mint);
    if (!tokenPriceUsd || tokenPriceUsd <= 0) {
      continue;
    }

    const tokenExposureUsd = Math.abs(tokenDeltaUi) * tokenPriceUsd;
    if (!Number.isFinite(tokenExposureUsd) || tokenExposureUsd <= 0) {
      continue;
    }

    if (tokenDeltaUi > 0) {
      maxIncomingTokenExposureUsd = Math.max(maxIncomingTokenExposureUsd, tokenExposureUsd);
    } else {
      maxOutgoingTokenExposureUsd = Math.max(maxOutgoingTokenExposureUsd, tokenExposureUsd);
    }
  }

  const matchedTokenExposureUsd = maxIncomingTokenExposureUsd > 0 && maxOutgoingTokenExposureUsd > 0
    ? Math.min(maxIncomingTokenExposureUsd, maxOutgoingTokenExposureUsd)
    : 0;

  if (solExposureUsd > 0 && matchedTokenExposureUsd > 0) {
    const smallerExposureUsd = Math.min(solExposureUsd, matchedTokenExposureUsd);
    const largerExposureUsd = Math.max(solExposureUsd, matchedTokenExposureUsd);
    if (smallerExposureUsd > 0 && (largerExposureUsd / smallerExposureUsd) > SCOUT_WALLET_EXPOSURE_SKEW_LIMIT) {
      return smallerExposureUsd;
    }
  }

  return Math.max(solExposureUsd, matchedTokenExposureUsd);
}

function getInstructionProgramId(instruction: unknown, accountKeys: unknown[]): string | null {
  if (!instruction || typeof instruction !== 'object') {
    return null;
  }

  if ('programId' in instruction) {
    return getAccountKeyString((instruction as { programId?: unknown }).programId) ?? null;
  }

  if ('programIdIndex' in instruction) {
    const programIdIndex = (instruction as { programIdIndex?: unknown }).programIdIndex;
    if (typeof programIdIndex === 'number' && programIdIndex >= 0 && programIdIndex < accountKeys.length) {
      return getAccountKeyString(accountKeys[programIdIndex]) ?? null;
    }
  }

  return null;
}

function hasKnownDexProgram(parsedTx: ParsedTransactionResponse): boolean {
  const accountKeys = (parsedTx?.transaction.message as { accountKeys?: unknown[] } | undefined)?.accountKeys ?? [];
  const topLevelInstructions = (parsedTx?.transaction.message as { instructions?: unknown[] } | undefined)?.instructions ?? [];

  for (const instruction of topLevelInstructions) {
    const programId = getInstructionProgramId(instruction, accountKeys);
    if (programId && SCOUT_KNOWN_DEX_PROGRAM_IDS.has(programId)) {
      return true;
    }
  }

  const innerInstructionGroups = parsedTx?.meta?.innerInstructions ?? [];
  for (const group of innerInstructionGroups) {
    const instructions = Array.isArray((group as { instructions?: unknown[] }).instructions)
      ? (group as { instructions: unknown[] }).instructions
      : [];
    for (const instruction of instructions) {
      const programId = getInstructionProgramId(instruction, accountKeys);
      if (programId && SCOUT_KNOWN_DEX_PROGRAM_IDS.has(programId)) {
        return true;
      }
    }
  }

  return false;
}

function getWalletTradedMints(parsedTx: ParsedTransactionResponse, walletAddress: string): string[] {
  const postBalances = parsedTx?.meta?.postTokenBalances ?? [];
  const preBalances = parsedTx?.meta?.preTokenBalances ?? [];
  const candidateMints = new Set<string>();

  for (const balance of [...preBalances, ...postBalances]) {
    if (balance.owner === walletAddress && typeof balance.mint === 'string' && balance.mint !== SOL_MINT) {
      candidateMints.add(balance.mint);
    }
  }

  const tradedMints: string[] = [];
  for (const mint of candidateMints) {
    const postRaw = postBalances
      .filter((balance) => balance.owner === walletAddress && balance.mint === mint)
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
    const preRaw = preBalances
      .filter((balance) => balance.owner === walletAddress && balance.mint === mint)
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);

    if (postRaw !== preRaw) {
      tradedMints.push(mint);
    }
  }

  return tradedMints;
}

function getWalletTokenRawDelta(parsedTx: ParsedTransactionResponse, walletAddress: string, mint: string): bigint {
  const postBalances = parsedTx?.meta?.postTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];
  const preBalances = parsedTx?.meta?.preTokenBalances?.filter(
    (balance) => balance.owner === walletAddress && balance.mint === mint,
  ) ?? [];

  const postRaw = postBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const preRaw = preBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  return postRaw - preRaw;
}

function isLikelySeedTraderWallet(
  parsedTx: ParsedTransactionResponse,
  walletAddress: string,
  mint: string,
): boolean {
  if (!isOnCurveAddress(walletAddress)) {
    return false;
  }

  if (getWalletTokenRawDelta(parsedTx, walletAddress, mint) === 0n) {
    return false;
  }

  if (getWalletSolExposure(parsedTx, walletAddress) >= MIN_RELIABLE_SCOUT_SOL_DELTA) {
    return true;
  }

  const signerAddress = getSignerAddress(parsedTx);
  if (signerAddress === walletAddress) {
    return true;
  }

  return hasKnownDexProgram(parsedTx) && getWalletTradedMints(parsedTx, walletAddress).length >= 2;
}

function isOnCurveAddress(address: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

function getSeedTraderAddresses(parsedTx: ParsedTransactionResponse, mint: string): string[] {
  const postBalances = parsedTx?.meta?.postTokenBalances?.filter(
    (balance) => typeof balance.owner === 'string' && balance.mint === mint,
  ) ?? [];
  const preBalances = parsedTx?.meta?.preTokenBalances?.filter(
    (balance) => typeof balance.owner === 'string' && balance.mint === mint,
  ) ?? [];

  const candidateOwners = new Set<string>();
  for (const balance of [...preBalances, ...postBalances]) {
    if (typeof balance.owner === 'string' && balance.owner.length > 0) {
      candidateOwners.add(balance.owner);
    }
  }

  const ownersWithDelta = [...candidateOwners]
    .filter((owner) => isLikelySeedTraderWallet(parsedTx, owner, mint))
    .map((owner) => ({ owner, rawDelta: getWalletTokenRawDelta(parsedTx, owner, mint) }))
    .filter((entry) => entry.rawDelta !== 0n)
    .sort((left, right) => {
      const leftAbs = left.rawDelta < 0n ? -left.rawDelta : left.rawDelta;
      const rightAbs = right.rawDelta < 0n ? -right.rawDelta : right.rawDelta;
      if (leftAbs === rightAbs) {
        return left.owner.localeCompare(right.owner);
      }

      return rightAbs > leftAbs ? 1 : -1;
    })
    .map((entry) => entry.owner);

  if (ownersWithDelta.length > 0) {
    return ownersWithDelta;
  }

  const signerAddress = getSignerAddress(parsedTx);
  if (!signerAddress || !isLikelySeedTraderWallet(parsedTx, signerAddress, mint)) {
    return [];
  }

  return getWalletTokenRawDelta(parsedTx, signerAddress, mint) !== 0n ? [signerAddress] : [];
}

async function fetchSolUsdPrice(): Promise<number | null> {
  try {
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
    if (response.ok) {
      const data = await response.json();
      const price = Number(data?.data?.[SOL_MINT]?.price);
      if (Number.isFinite(price) && price > 0) {
        return price;
      }
    }
  } catch {
    // Fall through to Dexscreener fallback.
  }

  try {
    const dexPriceUsd = getBestDexPriceUsd(await dexscreenerClient.searchTokenPairs(SOL_MINT), {
      minLiquidityUsd: SCOUT_MIN_TOKEN_PRICE_LIQUIDITY_USD,
      requireSolana: true,
    });
    if (dexPriceUsd) {
      return dexPriceUsd;
    }
  } catch {
    // Fall through to conservative fallback.
  }

  return DEFAULT_SOL_USD_FALLBACK;
}

function qualifiesAsEstablishedWhale(stats: ScoutCandidateStats, trader?: SeedTraderCandidate): boolean {
  return getCandidateEffectiveVolumeUsd(stats, trader) >= env.SCOUT_MIN_WHALE_VOLUME_USD
    && stats.qualifyingTradeCount >= env.SCOUT_MIN_WHALE_TX_COUNT
    && stats.distinctTokenCount >= env.SCOUT_MIN_WHALE_DISTINCT_TOKENS;
}

function qualifiesAsSpecialistPaperWhale(
  stats: ScoutCandidateStats,
  trader: SeedTraderCandidate,
  seed: ScoutSeedCandidate,
): boolean {
  const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(stats, trader);
  const specialistVolumeFloor = Math.max(
    SPECIALIST_WHALE_MIN_VOLUME_USD,
    env.SCOUT_MIN_WHALE_VOLUME_USD * SPECIALIST_WHALE_VOLUME_FACTOR,
  );
  const specialistTradeFloor = Math.max(
    env.SCOUT_MIN_WHALE_TX_COUNT + 2,
    env.SCOUT_MIN_WHALE_TX_COUNT * SPECIALIST_WHALE_MIN_TRADE_MULTIPLIER,
  );
  const specialistSeedVolumeFloor = Math.max(
    SPECIALIST_WHALE_MIN_SEED_VOLUME_USD,
    env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * 2,
  );
  const avgTradeUsd = getCandidateAverageTradeUsd(stats, trader);
  const seedShare = getCandidateSeedShare(stats, trader);

  return seed.highVolumeEligible
    && seed.marketAvgTradeUsd >= (env.SCOUT_MIN_SEED_AVG_TRADE_USD * PAPER_WHALE_SPECIALIST_MIN_SEED_AVG_TRADE_FACTOR)
    && effectiveVolumeUsd >= specialistVolumeFloor
    && stats.qualifyingTradeCount >= specialistTradeFloor
    && stats.distinctTokenCount >= 1
    && trader.tokenVolumeUsd >= specialistSeedVolumeFloor
    && avgTradeUsd >= getSpecialistPaperWhaleAvgTradeFloorUsd()
    && seedShare >= PAPER_WHALE_SPECIALIST_MIN_SEED_SHARE;
}

function qualifiesAsPaperWhaleCandidate(
  stats: ScoutCandidateStats,
  trader: SeedTraderCandidate,
  seed: ScoutSeedCandidate,
): boolean {
  return qualifiesAsEstablishedPaperWhale(stats, trader, seed)
    || qualifiesAsSpecialistPaperWhale(stats, trader, seed);
}

function getSeedSignatureScanCap(seed: ScoutSeedCandidate): number | undefined {
  if (!seed.highVolumeEligible) {
    return undefined;
  }

  if (seed.marketVolume24hUsd >= HIGH_VOLUME_SEED_DEEP_SCAN_VOLUME_USD || seed.marketTxCount24h >= HIGH_VOLUME_SEED_DEEP_SCAN_TX_COUNT) {
    return Math.max(env.SCOUT_TOKEN_SIGNATURE_SCAN_CAP, HIGH_VOLUME_SEED_DEEP_SCAN_CAP);
  }

  return undefined;
}

async function checkMigratedScoutSeed(mintAddress: string): Promise<MigratedSeedCheck> {
  const cached = getCachedMigratedScoutSeed(mintAddress);
  if (cached) {
    return cached;
  }

  try {
    const scoutLiquidity = await liquidityScreenService.screenScoutSeedLiquidity(mintAddress);
    const result: MigratedSeedCheck = {
      eligible: scoutLiquidity.eligible,
      reason: scoutLiquidity.reason,
      ...(scoutLiquidity.scanAddress ? { scanAddress: scoutLiquidity.scanAddress } : {}),
    };
    setCachedMigratedScoutSeed(mintAddress, result);
    return result;
  } catch (error) {
    const result: MigratedSeedCheck = {
      eligible: false,
      reason: error instanceof Error ? error.message : String(error),
    };
    setCachedMigratedScoutSeed(mintAddress, result);
    return result;
  }
}

async function collectTopTokenTraders(
  connection: Connection,
  mintAddress: string,
  scanAddress: string,
  solUsdPrice: number,
  tokenPriceUsd: number | null,
  signatureScanCapOverride?: number,
): Promise<SeedTraderCandidate[]> {
  const scanPubKey = new PublicKey(scanAddress);
  const initialSignatureTarget = Math.max(env.SCOUT_TOKEN_SIGNATURE_LIMIT, TOP_TRADERS_PER_TOKEN * 5);
  const signatureBatchLimit = Math.max(env.SCOUT_TOKEN_SIGNATURE_BATCH_LIMIT, initialSignatureTarget);
  const signatureScanCap = Math.max(
    env.SCOUT_TOKEN_SIGNATURE_SCAN_CAP,
    signatureScanCapOverride ?? 0,
    initialSignatureTarget,
  );
  let parsedTxBatchSize = Math.max(1, env.SCOUT_PARSED_TX_BATCH_SIZE);
  const cutoffTimestampSec = Math.floor(Date.now() / 1000) - (env.SCOUT_WHALE_LOOKBACK_HOURS * 60 * 60);
  const traderStats = new Map<string, SeedTraderCandidate>();
  let beforeSignature: string | undefined;
  let scannedSignatures = 0;
  let reachedCutoff = false;
  let abortedByRateLimit = false;
  let rateLimitedBatchCount = 0;
  let mintFallbackReason: string | null = null;

  while (scannedSignatures < signatureScanCap && !reachedCutoff && !abortedByRateLimit) {
    const remaining = signatureScanCap - scannedSignatures;
    const batchLimit = Math.min(signatureBatchLimit, remaining);
    let signatures;
    try {
      signatures = await getSignaturesForAddressWithRetry(connection, scanPubKey, {
        limit: batchLimit,
        ...(beforeSignature ? { before: beforeSignature } : {}),
      });
    } catch (error) {
      if (isSolanaRpcRateLimitError(error)) {
        abortedByRateLimit = true;
        await backOffAfterScoutRateLimit(`Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} (Signaturen)`);
        break;
      }

      throw error;
    }

    if (signatures.length === 0) {
      break;
    }

    for (let batchStart = 0; batchStart < signatures.length;) {
      const signatureBatch = signatures.slice(batchStart, batchStart + parsedTxBatchSize);
      const eligibleBatch = signatureBatch.filter((signature) => {
        scannedSignatures += 1;
        if (typeof signature.blockTime === 'number' && signature.blockTime < cutoffTimestampSec) {
          reachedCutoff = true;
          return false;
        }

        return true;
      });

      if (eligibleBatch.length === 0) {
        if (reachedCutoff) {
          break;
        }

        continue;
      }

      let batchRateLimited = false;

      try {
        const parsedTransactions = await getParsedTransactionsForScout(
          connection,
          eligibleBatch.map((signature) => signature.signature),
          {
            onBatchRetry: () => {
              batchRateLimited = true;
            },
          },
        );

        if (batchRateLimited) {
          rateLimitedBatchCount += 1;
          parsedTxBatchSize = reduceParsedTxBatchSize(
            parsedTxBatchSize,
            `Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)}`,
          );
          if (rateLimitedBatchCount >= SCOUT_MAX_RATE_LIMIT_BATCHES_PER_SCAN) {
            abortedByRateLimit = true;
            console.warn(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} frueh beendet: ${rateLimitedBatchCount} rate-limitierte TX-Batches.`);
            await backOffAfterScoutRateLimit(`Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} (TX-Batch-Budget)`);
          }
        }

        for (let index = 0; index < eligibleBatch.length; index += 1) {
          const signature = eligibleBatch[index]!;
          const tx = parsedTransactions[index] ?? null;
          if (!tx || tx.meta?.err) {
            continue;
          }

          const traderAddresses = getSeedTraderAddresses(tx, mintAddress);
          if (traderAddresses.length === 0) {
            continue;
          }

          for (const traderAddress of traderAddresses) {
            const tradeVolumeUsd = estimateSeedTradeVolumeUsd(
              tx,
              traderAddress,
              mintAddress,
              solUsdPrice,
              tokenPriceUsd,
            );
            if (!Number.isFinite(tradeVolumeUsd) || tradeVolumeUsd <= 0) {
              continue;
            }

            const existing = traderStats.get(traderAddress) ?? {
              walletAddress: traderAddress,
              tokenVolumeUsd: 0,
              tokenTradeCount: 0,
            };

            existing.tokenVolumeUsd += tradeVolumeUsd;
            existing.tokenTradeCount += 1;
            if (!existing.lastTradeAt && typeof signature.blockTime === 'number') {
              existing.lastTradeAt = new Date(signature.blockTime * 1000).toISOString();
            }

            traderStats.set(traderAddress, existing);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSolanaRpcRateLimitError(error)) {
          rateLimitedBatchCount += 1;
          const nextBatchSize = reduceParsedTxBatchSize(
            parsedTxBatchSize,
            `Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)}`,
          );
          if (nextBatchSize < parsedTxBatchSize) {
            parsedTxBatchSize = nextBatchSize;
            await backOffAfterScoutRateLimit(`Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} (TX-Batch)`);
            continue;
          }

          abortedByRateLimit = true;
          console.warn(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} abgebrochen: TX-Batch mit ${eligibleBatch.length} Signaturen lief trotz Minimal-Batch weiter ins RPC-Limit.`);
          await backOffAfterScoutRateLimit(`Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} (TX-Batch-Minimum)`);
          break;
        }

        console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)}: Batch mit ${eligibleBatch.length} Signaturen fehlgeschlagen: ${message}`);
      }

      batchStart += signatureBatch.length;

      if (reachedCutoff || abortedByRateLimit) {
        break;
      }

      await sleep(SCOUT_BATCH_PAUSE_MS);
    }

    beforeSignature = signatures.at(-1)?.signature;
    const qualifiedSeedTraderCount = [...traderStats.values()]
      .filter((trader) => trader.tokenVolumeUsd >= env.SCOUT_MIN_SEED_TRADER_VOLUME_USD)
      .length;
    const fallbackSeedTraderFloor = Math.max(
      HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_USD,
      100,
      env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_FACTOR,
    );
    const fallbackSeedTraderCount = [...traderStats.values()]
      .filter((trader) => trader.tokenVolumeUsd >= fallbackSeedTraderFloor)
      .length;
    const poolUsableSeedTraderFloor = Math.max(
      HIGH_VOLUME_SEED_POOL_CANDIDATE_MIN_VOLUME_USD,
      fallbackSeedTraderFloor,
    );
    const poolUsableSeedTraderCount = [...traderStats.values()]
      .filter((trader) => trader.tokenVolumeUsd >= poolUsableSeedTraderFloor)
      .length;
    const usingExtendedHighVolumeScan = signatureScanCap > env.SCOUT_TOKEN_SIGNATURE_SCAN_CAP;
    const coveredEarlyHighVolumeWindow = usingExtendedHighVolumeScan
      && scannedSignatures >= initialSignatureTarget
      && scannedSignatures < env.SCOUT_TOKEN_SIGNATURE_SCAN_CAP;
    const coveredBaseSeedWindow = scannedSignatures >= env.SCOUT_TOKEN_SIGNATURE_SCAN_CAP;
    const enoughQualifiedSeedTraderCandidates = qualifiedSeedTraderCount >= HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT;
    const enoughUsableSeedCandidates = qualifiedSeedTraderCount > 0
      && fallbackSeedTraderCount >= HIGH_VOLUME_SEED_MIN_USABLE_CANDIDATES;
    if (scanAddress !== mintAddress && scannedSignatures >= initialSignatureTarget && traderStats.size === 0) {
      mintFallbackReason = `blieb nach ${scannedSignatures} Signaturen ohne Trader`;
      console.log(`[SCOUT] Pool-Scan fuer ${mintAddress.slice(0, 8)} blieb nach ${scannedSignatures} Signaturen ohne Trader. Wechsle frueh auf Mint-Scan ${mintAddress.slice(0, 8)}.`);
      break;
    }

    if (coveredEarlyHighVolumeWindow) {
      if (scanAddress !== mintAddress) {
        if (poolUsableSeedTraderCount === 0) {
          mintFallbackReason = `lieferte nach Startfenster keine brauchbaren Trader >= $${poolUsableSeedTraderFloor.toFixed(0)}`;
          console.log(`[SCOUT] Pool-Scan fuer ${mintAddress.slice(0, 8)} liefert nach Startfenster keine brauchbaren Trader >= $${poolUsableSeedTraderFloor.toFixed(0)}. Wechsle frueh auf Mint-Scan ${mintAddress.slice(0, 8)}.`);
          break;
        }

        if (poolUsableSeedTraderCount >= HIGH_VOLUME_SEED_MIN_USABLE_CANDIDATES) {
          console.log(`[SCOUT] Pool-Scan fuer ${mintAddress.slice(0, 8)} stoppt nach Startfenster: ${poolUsableSeedTraderCount} Kandidaten >= $${poolUsableSeedTraderFloor.toFixed(0)} reichen fuer die Wallet-Pruefung.`);
          break;
        }
      } else {
        if (enoughQualifiedSeedTraderCandidates) {
          console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} stoppt nach Startfenster: ${qualifiedSeedTraderCount} Trader >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)} reichen fuer die Kandidatenpruefung.`);
          break;
        }

        if (enoughUsableSeedCandidates) {
          console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} stoppt nach Startfenster: ${qualifiedSeedTraderCount} Trader >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)} plus ${fallbackSeedTraderCount} Kandidaten >= $${fallbackSeedTraderFloor.toFixed(0)} reichen fuer die Wallet-Pruefung.`);
          break;
        }
      }
    }

    if (scannedSignatures >= initialSignatureTarget && qualifiedSeedTraderCount >= TOP_TRADERS_PER_TOKEN) {
      break;
    }

    if (usingExtendedHighVolumeScan && coveredBaseSeedWindow) {
      if (scanAddress !== mintAddress) {
        if (poolUsableSeedTraderCount === 0) {
          mintFallbackReason = `lieferte nach Basisfenster keine brauchbaren Trader >= $${poolUsableSeedTraderFloor.toFixed(0)}`;
          console.log(`[SCOUT] Pool-Scan fuer ${mintAddress.slice(0, 8)} liefert nach Basisfenster keine brauchbaren Trader >= $${poolUsableSeedTraderFloor.toFixed(0)}. Wechsle auf Mint-Scan ${mintAddress.slice(0, 8)}.`);
          break;
        }

        console.log(`[SCOUT] Pool-Scan fuer ${mintAddress.slice(0, 8)} stoppt nach Basisfenster: ${poolUsableSeedTraderCount} Kandidaten >= $${poolUsableSeedTraderFloor.toFixed(0)} reichen fuer die Wallet-Pruefung.`);
        break;
      }

      const coveredWeakSignalMintWindow = scannedSignatures >= Math.min(signatureScanCap, HIGH_VOLUME_SEED_WEAK_SIGNAL_SCAN_CAP);
      if (coveredWeakSignalMintWindow && qualifiedSeedTraderCount === 0 && fallbackSeedTraderCount === 0) {
        console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} stoppt nach ${scannedSignatures} Signaturen: kein Trader >= $${fallbackSeedTraderFloor.toFixed(0)} auf starkem Seed.`);
        break;
      }

      if (enoughQualifiedSeedTraderCandidates) {
        console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} stoppt nach Basisfenster: ${qualifiedSeedTraderCount} Trader >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)} reichen fuer die Kandidatenpruefung.`);
        break;
      }

      if (enoughUsableSeedCandidates) {
        console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} stoppt nach Basisfenster: ${qualifiedSeedTraderCount} Trader >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)} plus ${fallbackSeedTraderCount} Kandidaten >= $${fallbackSeedTraderFloor.toFixed(0)} reichen fuer die Wallet-Pruefung.`);
        break;
      }

      if (qualifiedSeedTraderCount === 0 && fallbackSeedTraderCount >= HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT) {
        console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)} stoppt nach Basisfenster: ${fallbackSeedTraderCount} Fallback-Trader >= $${fallbackSeedTraderFloor.toFixed(0)}, aber kein Trader >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)}.`);
        break;
      }
    }

    if (signatures.length < batchLimit || !beforeSignature) {
      break;
    }
  }

  const rankedTraders = [...traderStats.values()]
    .sort((left, right) => {
      const volumeDiff = right.tokenVolumeUsd - left.tokenVolumeUsd;
      if (volumeDiff !== 0) {
        return volumeDiff;
      }

      const tradeCountDiff = right.tokenTradeCount - left.tokenTradeCount;
      if (tradeCountDiff !== 0) {
        return tradeCountDiff;
      }

      return Date.parse(right.lastTradeAt ?? '0') - Date.parse(left.lastTradeAt ?? '0');
    });

  const qualifiedSeedTraderCount = rankedTraders.filter(
    (trader) => trader.tokenVolumeUsd >= env.SCOUT_MIN_SEED_TRADER_VOLUME_USD,
  ).length;

  if ((rankedTraders.length === 0 || mintFallbackReason) && scanAddress !== mintAddress && !abortedByRateLimit) {
    console.log(`[SCOUT] Pool-Scan fuer ${mintAddress.slice(0, 8)} ${mintFallbackReason ?? 'ergab 0 Trader'}. Fallback auf Mint-Scan ${mintAddress.slice(0, 8)}...`);
    return collectTopTokenTraders(connection, mintAddress, mintAddress, solUsdPrice, tokenPriceUsd, signatureScanCapOverride);
  }

  console.log(`[SCOUT] Seed-Scan ${mintAddress.slice(0, 8)} via ${scanAddress.slice(0, 8)}: ${scannedSignatures} Signaturen, ${rankedTraders.length} Trader, ${qualifiedSeedTraderCount} >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)}${abortedByRateLimit ? ' (frueh beendet wegen RPC-Limit)' : ''}.`);

  return rankedTraders.slice(0, TOP_TRADERS_PER_TOKEN);
}

async function evaluateWhaleCandidate(
  connection: Connection,
  walletAddress: string,
  solUsdPrice: number,
  signatureLimit = env.SCOUT_WHALE_SIGNATURE_LIMIT,
): Promise<ScoutCandidateStats | null> {
  let walletPubKey: PublicKey;
  try {
    walletPubKey = new PublicKey(walletAddress);
  } catch {
    return null;
  }

  const cutoffTimestampSec = Math.floor(Date.now() / 1000) - (env.SCOUT_WHALE_LOOKBACK_HOURS * 60 * 60);
  const signatures = await collectWalletSignatures(
    connection,
    walletPubKey,
    walletAddress,
    signatureLimit,
    cutoffTimestampSec,
  );
  if (!signatures) {
    return null;
  }

  let parsedTxBatchSize = Math.max(1, env.SCOUT_PARSED_TX_BATCH_SIZE);
  let estimatedVolumeUsd = 0;
  let qualifyingTradeCount = 0;
  let lastTradeAt: string | undefined;
  const distinctTokenMints = new Set<string>();
  let abortedByRateLimit = false;
  let rateLimitedBatchCount = 0;

  for (let batchStart = 0; batchStart < signatures.length;) {
    const signatureBatch = signatures.slice(batchStart, batchStart + parsedTxBatchSize);
    const eligibleBatch = signatureBatch.filter((signature) => (
      typeof signature.blockTime !== 'number' || signature.blockTime >= cutoffTimestampSec
    ));

    if (eligibleBatch.length === 0) {
      if (signatureBatch.some((signature) => typeof signature.blockTime === 'number' && signature.blockTime < cutoffTimestampSec)) {
        break;
      }

      continue;
    }

    let batchRateLimited = false;

    try {
      const parsedTransactions = await getParsedTransactionsForScout(
        connection,
        eligibleBatch.map((signature) => signature.signature),
        {
          onBatchRetry: () => {
            batchRateLimited = true;
          },
        },
      );

      if (batchRateLimited) {
        rateLimitedBatchCount += 1;
        parsedTxBatchSize = reduceParsedTxBatchSize(
          parsedTxBatchSize,
          `Wallet-Pruefung ${walletAddress.slice(0, 8)}`,
        );
        if (rateLimitedBatchCount >= SCOUT_MAX_RATE_LIMIT_BATCHES_PER_SCAN) {
          abortedByRateLimit = true;
          console.warn(`[SCOUT] Wallet-Pruefung fuer ${walletAddress.slice(0, 8)} frueh beendet: ${rateLimitedBatchCount} rate-limitierte TX-Batches.`);
          await backOffAfterScoutRateLimit(`Wallet-Pruefung ${walletAddress.slice(0, 8)} (TX-Batch-Budget)`);
        }
      }

      for (let index = 0; index < eligibleBatch.length; index += 1) {
        const signature = eligibleBatch[index]!;
        const tx = parsedTransactions[index] ?? null;
        if (!tx || tx.meta?.err) {
          continue;
        }

        const tradedMints = getWalletTradedMints(tx, walletAddress);
        if (tradedMints.length === 0) {
          continue;
        }

        const meaningfulTradedMints = filterMeaningfulWhaleTargetMints(tradedMints);
        if (meaningfulTradedMints.length === 0) {
          continue;
        }

        const tradeVolumeUsd = await estimateWalletTradeVolumeUsd(
          tx,
          walletAddress,
          tradedMints,
          solUsdPrice,
        );
        if (!Number.isFinite(tradeVolumeUsd) || tradeVolumeUsd <= 0) {
          continue;
        }

        estimatedVolumeUsd += tradeVolumeUsd;
        qualifyingTradeCount += 1;
        meaningfulTradedMints.forEach((mint) => distinctTokenMints.add(mint));
        if (!lastTradeAt && typeof signature.blockTime === 'number') {
          lastTradeAt = new Date(signature.blockTime * 1000).toISOString();
        }
      }
    } catch (error) {
      if (isSolanaRpcRateLimitError(error)) {
        rateLimitedBatchCount += 1;
        const nextBatchSize = reduceParsedTxBatchSize(
          parsedTxBatchSize,
          `Wallet-Pruefung ${walletAddress.slice(0, 8)}`,
        );
        if (nextBatchSize < parsedTxBatchSize) {
          parsedTxBatchSize = nextBatchSize;
          await backOffAfterScoutRateLimit(`Wallet-Pruefung ${walletAddress.slice(0, 8)} (TX-Batch)`);
          continue;
        }

        abortedByRateLimit = true;
        console.warn(`[SCOUT] Wallet-Pruefung fuer ${walletAddress.slice(0, 8)} abgebrochen: TX-Batch mit ${eligibleBatch.length} Signaturen lief trotz Minimal-Batch weiter ins RPC-Limit.`);
        await backOffAfterScoutRateLimit(`Wallet-Pruefung ${walletAddress.slice(0, 8)} (TX-Batch-Minimum)`);
        break;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.log(`[SCOUT] Wallet-Pruefung fuer ${walletAddress.slice(0, 8)} fehlgeschlagen: ${message}`);
    }

    batchStart += signatureBatch.length;

    if (abortedByRateLimit) {
      break;
    }

    await sleep(SCOUT_BATCH_PAUSE_MS);
  }

  if (abortedByRateLimit) {
    return null;
  }

  return {
    estimatedVolumeUsd,
    qualifyingTradeCount,
    distinctTokenCount: distinctTokenMints.size,
    lookbackHours: env.SCOUT_WHALE_LOOKBACK_HOURS,
    ...(lastTradeAt ? { lastTradeAt } : {}),
  };
}

async function buildScoutSeeds(seedInputs: RawScoutSeedInput[]): Promise<ScoutSeedCandidate[]> {
  const scoutSeeds: ScoutSeedCandidate[] = [];

  for (const seedInput of seedInputs) {
    const mintAddress = seedInput.tokenAddress;
    if (isNonTargetWhaleMint(mintAddress)) {
      const skippedLabel = describeNonTargetWhaleMint(mintAddress);
      console.log(`[SCOUT] Ueberspringe Seed ${mintAddress}: ${skippedLabel} ist ein bekannter Core-/Quote-Token und kein Scout-Ziel.`);
      updateRuntimeStatus('scout', {
        lastSkippedSeedToken: mintAddress,
        lastSkippedSeedReason: `${skippedLabel} ist ein bekannter Core-/Quote-Token.`,
      });
      continue;
    }

    const migratedSeed = await checkMigratedScoutSeed(mintAddress);
    if (!migratedSeed.eligible) {
      console.log(`[SCOUT] Ueberspringe Seed ${mintAddress}: ${migratedSeed.reason}.`);
      updateRuntimeStatus('scout', {
        lastSkippedSeedToken: mintAddress,
        lastSkippedSeedReason: migratedSeed.reason,
      });
      continue;
    }

    let bestPair: DexPairSummary | null = null;
    try {
      bestPair = pickBestScoutSeedPair(mintAddress, await dexscreenerClient.searchTokenPairs(mintAddress));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[SCOUT] Seed-Marktcheck fuer ${mintAddress} fehlgeschlagen: ${message}`);
    }

    const scoutSeed: ScoutSeedCandidate = {
      mintAddress,
      scanAddress: migratedSeed.scanAddress ?? mintAddress,
      source: seedInput.source,
      reason: migratedSeed.reason,
      boostWeight: seedInput.boostWeight,
      marketPriceUsd: getPairPriceUsd(bestPair),
      marketVolume24hUsd: getPairVolume24hUsd(bestPair),
      marketLiquidityUsd: getPairLiquidityUsd(bestPair),
      marketTxCount24h: getPairTxCount24h(bestPair),
      marketAvgTradeUsd: getPairAverageTradeUsd(bestPair),
      highVolumeEligible: false,
    };
    scoutSeed.highVolumeEligible = qualifiesAsHighVolumeSeed(scoutSeed);
    scoutSeeds.push(scoutSeed);
  }

  return scoutSeeds.sort((left, right) => {
    if (left.highVolumeEligible !== right.highVolumeEligible) {
      return Number(right.highVolumeEligible) - Number(left.highVolumeEligible);
    }

    const avgTradeDiff = right.marketAvgTradeUsd - left.marketAvgTradeUsd;
    if (avgTradeDiff !== 0) {
      return avgTradeDiff;
    }

    const volumeDiff = right.marketVolume24hUsd - left.marketVolume24hUsd;
    if (volumeDiff !== 0) {
      return volumeDiff;
    }

    const liquidityDiff = right.marketLiquidityUsd - left.marketLiquidityUsd;
    if (liquidityDiff !== 0) {
      return liquidityDiff;
    }

    const txDiff = right.marketTxCount24h - left.marketTxCount24h;
    if (txDiff !== 0) {
      return txDiff;
    }

    return right.boostWeight - left.boostWeight;
  });
}

async function scout() {
  console.log('[SCOUT] Starte Whale-Suche ueber qualifizierte Seed-Tokens...');
  const rejectedCandidates = readRejectedCandidateStore();
  let rejectedCandidatesDirty = pruneRejectedCandidateStore(rejectedCandidates);
  updateRuntimeStatus('scout', {
    lastRunAt: new Date().toISOString(),
    state: 'running',
  });
  try {
    const connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });

    const [boostScoutSeedInputs, marketScoutSeedInputs] = await Promise.all([
      fetchBoostScoutSeedInputs(),
      fetchMarketScoutSeedInputs(),
    ]);
    const scoutSeedInputs = mergeScoutSeedInputs(boostScoutSeedInputs, marketScoutSeedInputs);

    if (scoutSeedInputs.length === 0) {
      updateRuntimeStatus('scout', {
        state: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastAddedCount: 0,
        whaleCount: readWhales().length,
        boostSeedInputCount: 0,
        marketSeedInputCount: 0,
      });
      return;
    }

    const seedInputsToCheck = scoutSeedInputs.slice(0, Math.max(env.SCOUT_SEED_CHECK_LIMIT, env.SCOUT_BOOST_TOKEN_LIMIT));
    const eligibleScoutSeeds = await buildScoutSeeds(seedInputsToCheck);
    const highVolumeScoutSeeds = eligibleScoutSeeds.filter((seed) => seed.highVolumeEligible);
    const fallbackScoutSeeds = eligibleScoutSeeds.filter((seed) => qualifiesAsNearHighVolumeFallbackSeed(seed));
    const usingFallbackSeeds = highVolumeScoutSeeds.length === 0 && fallbackScoutSeeds.length > 0;
    const bestFallbackSeed = fallbackScoutSeeds[0];
    if (usingFallbackSeeds && bestFallbackSeed) {
      console.log(`[SCOUT] Keine Seeds ueber High-Volume-Schwelle inkl. AvgTx >= $${env.SCOUT_MIN_SEED_AVG_TRADE_USD}. Nutze nur starke Near-Threshold-Fallbacks ab ${bestFallbackSeed.mintAddress.slice(0, 8)} (AvgTx ~$${bestFallbackSeed.marketAvgTradeUsd.toFixed(0)}, Vol24h ~$${bestFallbackSeed.marketVolume24hUsd.toFixed(0)}).`);
    }
    const scoutSeeds = (usingFallbackSeeds ? fallbackScoutSeeds : highVolumeScoutSeeds)
      .slice(0, env.SCOUT_BOOST_TOKEN_LIMIT);

    if (eligibleScoutSeeds.length === 0) {
      console.log('[SCOUT] Keine scoutbaren Seeds mit Marktinformationen verfuegbar.');
      updateRuntimeStatus('scout', {
        state: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastAddedCount: 0,
        whaleCount: readWhales().length,
        eligibleSeedCount: 0,
        migratedSeedCount: 0,
        highVolumeSeedCount: 0,
      });
      return;
    }

    if (highVolumeScoutSeeds.length === 0 && fallbackScoutSeeds.length === 0) {
      console.warn(`[SCOUT] Kein scoutbarer Seed ist stark genug fuer Whale-Discovery. Fallback erfordert aktuell etwa >= $${Math.max(50_000, env.SCOUT_MIN_SEED_VOLUME_USD * NEAR_HIGH_VOLUME_FALLBACK_SEED_VOLUME_FACTOR).toFixed(0)} Vol24h, >= $${Math.max(15_000, env.SCOUT_MIN_SEED_LIQUIDITY_USD * NEAR_HIGH_VOLUME_FALLBACK_SEED_LIQUIDITY_FACTOR).toFixed(0)} Liq, >= ${Math.max(60, Math.floor(env.SCOUT_MIN_SEED_TX_COUNT * NEAR_HIGH_VOLUME_FALLBACK_SEED_TX_FACTOR))} TX und AvgTx >= $${Math.max(100, env.SCOUT_MIN_SEED_AVG_TRADE_USD * NEAR_HIGH_VOLUME_FALLBACK_SEED_AVG_TRADE_FACTOR).toFixed(0)}.`);
      updateRuntimeStatus('scout', {
        state: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastAddedCount: 0,
        whaleCount: readWhales().length,
        eligibleSeedCount: eligibleScoutSeeds.length,
        migratedSeedCount: eligibleScoutSeeds.length,
        highVolumeSeedCount: highVolumeScoutSeeds.length,
      });
      return;
    }

    if (usingFallbackSeeds) {
      console.warn(`[SCOUT] Kein scoutbarer Seed erfuellt den High-Volume-Filter (Vol24h >= $${env.SCOUT_MIN_SEED_VOLUME_USD.toFixed(0)}, Liq >= $${env.SCOUT_MIN_SEED_LIQUIDITY_USD.toFixed(0)}, Tx >= ${env.SCOUT_MIN_SEED_TX_COUNT}). Nutze nur Near-Threshold-Fallback-Seeds statt beliebiger Restkandidaten.`);
    }

    const currentWhales = readWhales();
    const knownWhales = new Set(currentWhales.map((whale) => whale.address));
    const evaluatedCandidates = new Set<string>();
    const solUsdPrice = await fetchSolUsdPrice();
    if (!solUsdPrice || solUsdPrice <= 0) {
      throw new Error('SOL/USD Preis konnte fuer den Scout auch ueber Fallbacks nicht geladen werden.');
    }

    if (solUsdPrice === DEFAULT_SOL_USD_FALLBACK) {
      console.warn(`[SCOUT] SOL/USD Fallback aktiv (${DEFAULT_SOL_USD_FALLBACK}). Whale-Selektion laeuft konservativ weiter.`);
      updateRuntimeStatus('scout', {
        solUsdPriceFallback: DEFAULT_SOL_USD_FALLBACK,
      });
    } else {
      updateRuntimeStatus('scout', {
        solUsdPrice,
        solUsdPriceFallback: null,
      });
    }

    let addedCount = 0;
    let cooldownSkippedCandidates = 0;
    const eligibleSeedCount = eligibleScoutSeeds.length;
    const highVolumeSeedCount = highVolumeScoutSeeds.length;

    for (const seed of scoutSeeds) {
      if (addedCount >= MAX_NEW_WHALES_PER_RUN || evaluatedCandidates.size >= MAX_CANDIDATES_PER_RUN) {
        break;
      }

      const mintAddress = seed.mintAddress;
      updateRuntimeStatus('scout', {
        lastToken: mintAddress,
        lastEligibleSeedToken: mintAddress,
        lastEligibleSeedReason: seed.reason,
        lastMigratedSeedToken: mintAddress,
        lastMigratedSeedReason: seed.reason,
        lastSeedMarketVolumeUsd: Math.round(seed.marketVolume24hUsd),
        lastSeedMarketLiquidityUsd: Math.round(seed.marketLiquidityUsd),
        lastSeedMarketTxCount: seed.marketTxCount24h,
      });

      const seedModeLabel = seed.highVolumeEligible ? 'high-volume' : 'fallback';
      const seedSignatureScanCap = getSeedSignatureScanCap(seed);
      console.log(`[SCOUT] Pruefe Top-${TOP_TRADERS_PER_TOKEN}-Trader ueber Seed ${mintAddress} via ${seed.scanAddress} (${seed.reason}, source ${seed.source}, ${seedModeLabel}, Vol24h ~$${seed.marketVolume24hUsd.toFixed(0)}, Liq ~$${seed.marketLiquidityUsd.toFixed(0)}, Tx ${seed.marketTxCount24h}, AvgTx ~$${seed.marketAvgTradeUsd.toFixed(0)}${seedSignatureScanCap ? `, Scan-Cap ${seedSignatureScanCap}` : ''})...`);
      let topTokenTraders: SeedTraderCandidate[];
      try {
        topTokenTraders = await collectTopTokenTraders(
          connection,
          mintAddress,
          seed.scanAddress,
          solUsdPrice,
          seed.marketPriceUsd > 0 ? seed.marketPriceUsd : null,
          seedSignatureScanCap,
        );
      } catch (error) {
        if (isSolanaRpcRateLimitError(error)) {
          await backOffAfterScoutRateLimit(`Seed-Scan ${mintAddress.slice(0, 8)} via ${seed.scanAddress.slice(0, 8)}`);
          continue;
        }

        throw error;
      }

      const qualifiedSeedTraderCount = topTokenTraders.filter(
        (trader) => trader.tokenVolumeUsd >= env.SCOUT_MIN_SEED_TRADER_VOLUME_USD,
      ).length;
      const allowHighVolumeSeedFallback = seed.highVolumeEligible
        && qualifiedSeedTraderCount < HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT;
      const highVolumeSeedFallbackFloor = Math.max(
        HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_USD,
        100,
        env.SCOUT_MIN_SEED_TRADER_VOLUME_USD * HIGH_VOLUME_SEED_FALLBACK_MIN_VOLUME_FACTOR,
      );

      for (let traderIndex = 0; traderIndex < topTokenTraders.length; traderIndex += 1) {
        const trader = topTokenTraders[traderIndex]!;
        if (addedCount >= MAX_NEW_WHALES_PER_RUN || evaluatedCandidates.size >= MAX_CANDIDATES_PER_RUN) {
          break;
        }

        const walletAddress = trader.walletAddress;

        if (knownWhales.has(walletAddress)) {
          continue;
        }

        if (isCandidateCoolingDown(rejectedCandidates, walletAddress)) {
          cooldownSkippedCandidates += 1;
          evaluatedCandidates.add(walletAddress);
          continue;
        }

        const allowFallbackTrader = allowHighVolumeSeedFallback
          && traderIndex < HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT
          && trader.tokenVolumeUsd >= highVolumeSeedFallbackFloor;

        if (trader.tokenVolumeUsd < env.SCOUT_MIN_SEED_TRADER_VOLUME_USD && !allowFallbackTrader) {
          console.log(`[SCOUT] Ueberspringe ${walletAddress.slice(0, 8)}: Seed-Vol $${trader.tokenVolumeUsd.toFixed(0)} unter Mindestwert $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)}.`);
          continue;
        }

        if (allowFallbackTrader) {
          if (trader.tokenVolumeUsd < env.SCOUT_MIN_SEED_TRADER_VOLUME_USD) {
            console.log(`[SCOUT] High-Volume-Seed-Fallback fuer ${walletAddress.slice(0, 8)}: Seed-Vol $${trader.tokenVolumeUsd.toFixed(0)} unter Standard-$${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)}, aber Top-${HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT} auf starkem Seed.`);
          } else {
            console.log(`[SCOUT] High-Volume-Seed-Zusatzkandidat fuer ${walletAddress.slice(0, 8)}: Seed-Vol $${trader.tokenVolumeUsd.toFixed(0)} und Top-${HIGH_VOLUME_SEED_FALLBACK_TRADER_COUNT} auf starkem Seed, obwohl erst ${qualifiedSeedTraderCount} Trader >= $${env.SCOUT_MIN_SEED_TRADER_VOLUME_USD.toFixed(0)} gefunden wurden.`);
          }
        }

        if (evaluatedCandidates.has(walletAddress)) {
          continue;
        }

        evaluatedCandidates.add(walletAddress);
        const quickStats = await evaluateWhaleCandidate(connection, walletAddress, solUsdPrice);
        if (!quickStats) {
          continue;
        }

        let candidateStats = quickStats;
        if (!qualifiesAsPaperWhaleCandidate(candidateStats, trader, seed)
          && env.SCOUT_WHALE_DEEP_SIGNATURE_LIMIT > env.SCOUT_WHALE_SIGNATURE_LIMIT
          && shouldDeepScanCandidate(candidateStats, trader)) {
          console.log(`[SCOUT] Vertiefe Wallet-Pruefung fuer ${walletAddress.slice(0, 8)}: Quick-Vol $${candidateStats.estimatedVolumeUsd.toFixed(0)}, Seed-Vol $${trader.tokenVolumeUsd.toFixed(0)}.`);
          candidateStats = await evaluateWhaleCandidate(
            connection,
            walletAddress,
            solUsdPrice,
            env.SCOUT_WHALE_DEEP_SIGNATURE_LIMIT,
          ) ?? candidateStats;
        }

        if (!qualifiesAsPaperWhaleCandidate(candidateStats, trader, seed)
          && env.SCOUT_WHALE_EXTENDED_SIGNATURE_LIMIT > env.SCOUT_WHALE_DEEP_SIGNATURE_LIMIT
          && shouldExtendedScanCandidate(candidateStats, trader)) {
          console.log(`[SCOUT] Erweitere Wallet-Pruefung fuer ${walletAddress.slice(0, 8)}: Vol $${candidateStats.estimatedVolumeUsd.toFixed(0)}, Trades ${candidateStats.qualifyingTradeCount}, Tokens ${candidateStats.distinctTokenCount}.`);
          candidateStats = await evaluateWhaleCandidate(
            connection,
            walletAddress,
            solUsdPrice,
            env.SCOUT_WHALE_EXTENDED_SIGNATURE_LIMIT,
          ) ?? candidateStats;
        }

        const specialistPaperWhale = !qualifiesAsEstablishedWhale(candidateStats, trader)
          && qualifiesAsSpecialistPaperWhale(candidateStats, trader, seed);

        if (!qualifiesAsPaperWhaleCandidate(candidateStats, trader, seed)) {
          const rejectReason = buildPaperWhaleRejectReason(candidateStats, trader, seed);
          const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(candidateStats, trader);
          const avgTradeUsd = getCandidateAverageTradeUsd(candidateStats, trader);
          const seedSharePct = getCandidateSeedShare(candidateStats, trader) * 100;
          rememberRejectedCandidate(rejectedCandidates, walletAddress, rejectReason, candidateStats, mintAddress, trader);
          rejectedCandidatesDirty = true;
          console.log(`[SCOUT] Verwerfe ${walletAddress.slice(0, 8)}: Vol $${effectiveVolumeUsd.toFixed(0)}, Trades ${candidateStats.qualifyingTradeCount}, Tokens ${candidateStats.distinctTokenCount}, AvgTrade $${avgTradeUsd.toFixed(0)}, SeedShare ${seedSharePct.toFixed(0)}% (${rejectReason}). Cooldown ${env.SCOUT_REJECT_COOLDOWN_MINUTES}m.`);
          continue;
        }

        if (specialistPaperWhale) {
          console.log(`[SCOUT] Akzeptiere spezialisierten Paper-Wal ${walletAddress.slice(0, 8)}: Vol $${getCandidateEffectiveVolumeUsd(candidateStats, trader).toFixed(0)}, Trades ${candidateStats.qualifyingTradeCount}, Tokens ${candidateStats.distinctTokenCount}, AvgTrade $${getCandidateAverageTradeUsd(candidateStats, trader).toFixed(0)}, Seed-Vol $${trader.tokenVolumeUsd.toFixed(0)}.`);
        }

        const effectiveVolumeUsd = getCandidateEffectiveVolumeUsd(candidateStats, trader);

        const discoveredAt = new Date().toISOString();
        const newWhale: WhaleRecord = {
          address: walletAddress,
          mode: 'paper',
          discoveredAt,
          promotedAt: null,
          paperTrades: 0,
          liveTrades: 0,
          estimatedVolumeUsd: Math.round(effectiveVolumeUsd),
          qualifyingTradeCount: candidateStats.qualifyingTradeCount,
          distinctTokenCount: candidateStats.distinctTokenCount,
          lastScoutedAt: discoveredAt,
          lastScoutedToken: mintAddress,
          lastScoutedReason: seed.reason,
          seedTraderRank: traderIndex + 1,
          seedTokenVolumeUsd: Math.round(trader.tokenVolumeUsd),
          seedTokenTradeCount: trader.tokenTradeCount,
        };

        currentWhales.push(newWhale);
        knownWhales.add(walletAddress);
        rejectedCandidatesDirty = clearRejectedCandidate(rejectedCandidates, walletAddress) || rejectedCandidatesDirty;
        addedCount += 1;
        upsertWhale(newWhale);

  console.log(`[SCOUT] Neuer etablierter Trader entdeckt: ${walletAddress} mit ca. $${effectiveVolumeUsd.toFixed(0)} Volumen in ${candidateStats.lookbackHours}h (Seed-Rank Volumen ~$${trader.tokenVolumeUsd.toFixed(0)} aus ${trader.tokenTradeCount} Trades).`);
  await sendTelegram(`🎯 <b>NEUER WAL GEFUNDEN</b>\nSeed-Token: <code>${mintAddress}</code>\nSeed-Route: <b>${seed.reason.toUpperCase()}</b>\nSeed-Markt: <b>$${seed.marketVolume24hUsd.toFixed(0)}</b> Vol24h · <b>$${seed.marketLiquidityUsd.toFixed(0)}</b> Liq · <b>${seed.marketTxCount24h}</b> TX\nSeed-Ranking: <b>Top-${TOP_TRADERS_PER_TOKEN}</b> mit ca. <b>$${trader.tokenVolumeUsd.toFixed(0)}</b> auf diesem Coin\nWallet: <code>${walletAddress}</code>\nGeschaetztes Volumen: <b>$${effectiveVolumeUsd.toFixed(0)}</b> in ${candidateStats.lookbackHours}h\nTrades: <b>${candidateStats.qualifyingTradeCount}</b>\nTokens: <b>${candidateStats.distinctTokenCount}</b>\nStatus: <b>PAPER</b>`, {
          dedupeKey: `scout-new-whale:${mintAddress}:${walletAddress}`,
          cooldownMs: 24 * 60 * 60 * 1000,
        });

        console.log(`[SCOUT] Seed ${mintAddress.slice(0, 8)} hat einen neuen Whale geliefert. Wechsle zum naechsten Seed.`);
        break;
      }
    }

    if (addedCount > 0) {
      console.log(`[SCOUT] ${addedCount} neue qualifizierte Paper-Wale hinzugefuegt.`);
    } else {
      console.log('[SCOUT] Keine neuen qualifizierten Paper-Wale hinzugefuegt.');
    }

    updateRuntimeStatus('scout', {
      state: 'idle',
      lastSuccessAt: new Date().toISOString(),
      lastAddedCount: addedCount,
      whaleCount: currentWhales.length,
      lastToken: scoutSeeds[0]?.mintAddress,
      lastEvaluatedCandidates: evaluatedCandidates.size,
      cooldownSkippedCandidates,
      eligibleSeedCount,
      migratedSeedCount: eligibleSeedCount,
      highVolumeSeedCount,
      boostSeedInputCount: boostScoutSeedInputs.length,
      marketSeedInputCount: marketScoutSeedInputs.length,
      mergedSeedInputCount: scoutSeedInputs.length,
      seedCheckInputCount: seedInputsToCheck.length,
      usingFallbackSeeds,
      minSeedVolumeUsd: env.SCOUT_MIN_SEED_VOLUME_USD,
      minSeedLiquidityUsd: env.SCOUT_MIN_SEED_LIQUIDITY_USD,
      minSeedTxCount: env.SCOUT_MIN_SEED_TX_COUNT,
      minSeedTraderVolumeUsd: env.SCOUT_MIN_SEED_TRADER_VOLUME_USD,
      minWhaleVolumeUsd: env.SCOUT_MIN_WHALE_VOLUME_USD,
    });

  } catch (e: any) {
    console.error('Scout Fehler:', e.message);
    updateRuntimeStatus('scout', {
      state: 'error',
      lastErrorAt: new Date().toISOString(),
      lastError: e.message,
    });
  } finally {
    if (rejectedCandidatesDirty) {
      writeRejectedCandidateStore(rejectedCandidates);
    }
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
