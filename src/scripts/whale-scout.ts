import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { fileURLToPath } from 'url';
import { env, getReadOnlyRpcUrl } from '../config/env.js';
import { DexscreenerClient } from '../clients/dexscreener.js';
import { LiquidityScreenService } from '../services/liquidity-screen.js';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";
import { normalizeWhales, type WhaleRecord } from '../storage/whales.js';
import { updateRuntimeStatus } from '../storage/runtime-status.js';
import type { DexPairSummary } from '../types/market.js';

const RPC_URL = getReadOnlyRpcUrl();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WHALE_FILE = path.resolve(SCRIPT_DIR, '../data/whales.json');
const EMPTY_SCOUT_INTERVAL_MS = 60 * 1000;
const FAST_SCOUT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SCOUT_INTERVAL_MS = 60 * 60 * 1000;
const FAST_SCOUT_WHALE_TARGET = 100;
const MAX_NEW_WHALES_PER_RUN = 2;
const MAX_CANDIDATES_PER_RUN = 12;
const TOP_TRADERS_PER_TOKEN = 10;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_SOL_USD_FALLBACK = 100;
const dexscreenerClient = new DexscreenerClient();
const liquidityScreenService = new LiquidityScreenService();

type ParsedTransactionResponse = Awaited<ReturnType<Connection['getParsedTransaction']>>;

type DexBoostToken = {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
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
};

type SeedTraderCandidate = {
  walletAddress: string;
  tokenVolumeUsd: number;
  tokenTradeCount: number;
  lastTradeAt?: string;
};

// Hilfsfunktion für Pausen
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
  const whaleCount = normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length;
  if (whaleCount === 0) {
    return EMPTY_SCOUT_INTERVAL_MS;
  }

  return whaleCount < FAST_SCOUT_WHALE_TARGET ? FAST_SCOUT_INTERVAL_MS : DEFAULT_SCOUT_INTERVAL_MS;
}

function logNextScoutRun() {
  const whaleCount = normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length;
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

function getBestDexPriceUsd(pairs: DexPairSummary[]): number | null {
  const bestPair = [...pairs]
    .filter((pair) => Number.isFinite(Number(pair.priceUsd)) && Number(pair.priceUsd) > 0)
    .sort((left, right) => (Number(right.liquidity?.usd) || 0) - (Number(left.liquidity?.usd) || 0))[0];

  if (!bestPair) {
    return null;
  }

  const priceUsd = Number(bestPair.priceUsd);
  return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
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
    const dexPriceUsd = getBestDexPriceUsd(await dexscreenerClient.searchTokenPairs(SOL_MINT));
    if (dexPriceUsd) {
      return dexPriceUsd;
    }
  } catch {
    // Fall through to conservative fallback.
  }

  return DEFAULT_SOL_USD_FALLBACK;
}

function qualifiesAsEstablishedWhale(stats: ScoutCandidateStats): boolean {
  return stats.estimatedVolumeUsd >= env.SCOUT_MIN_WHALE_VOLUME_USD
    && stats.qualifyingTradeCount >= env.SCOUT_MIN_WHALE_TX_COUNT
    && stats.distinctTokenCount >= env.SCOUT_MIN_WHALE_DISTINCT_TOKENS;
}

async function checkMigratedScoutSeed(mintAddress: string): Promise<MigratedSeedCheck> {
  try {
    const liquidity = await liquidityScreenService.screenLiquidity(mintAddress);
    const pumpStatus = liquidity.pumpFun?.status;
    const hasAmmEvidence = Boolean(liquidity.pool?.pairAddress) || liquidity.pumpFun?.canonicalPoolDetected === true;

    if (pumpStatus === 'migrated' && hasAmmEvidence) {
      return {
        eligible: true,
        reason: liquidity.pool?.dexId ?? 'pumpfun-migrated',
      };
    }

    if (pumpStatus === 'bonding-curve-live') {
      return {
        eligible: false,
        reason: 'token still on bonding curve',
      };
    }

    if (pumpStatus === 'migrated') {
      return {
        eligible: false,
        reason: 'migration detected but no AMM pool evidence',
      };
    }

    return {
      eligible: false,
      reason: `pump status ${pumpStatus ?? 'unknown'}`,
    };
  } catch (error) {
    return {
      eligible: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectTopTokenTraders(
  connection: Connection,
  mintAddress: string,
  solUsdPrice: number,
): Promise<SeedTraderCandidate[]> {
  const mintPubKey = new PublicKey(mintAddress);
  const signatureLimit = Math.max(env.SCOUT_TOKEN_SIGNATURE_LIMIT, TOP_TRADERS_PER_TOKEN * 5);
  const signatures = await connection.getSignaturesForAddress(mintPubKey, { limit: signatureLimit });
  const traderStats = new Map<string, SeedTraderCandidate>();

  for (const signature of signatures) {
    try {
      const tx = await connection.getParsedTransaction(signature.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) {
        await sleep(250);
        continue;
      }

      const signerAddress = getSignerAddress(tx);
      if (!signerAddress) {
        await sleep(250);
        continue;
      }

      const tokenRawDelta = getWalletTokenRawDelta(tx, signerAddress, mintAddress);
      if (tokenRawDelta === 0n) {
        await sleep(250);
        continue;
      }

      const solDelta = getWalletNativeSolDelta(tx, signerAddress);
      const tradeVolumeUsd = solDelta === null ? 0 : Math.abs(solDelta) * solUsdPrice;
      if (!Number.isFinite(tradeVolumeUsd) || tradeVolumeUsd <= 0) {
        await sleep(250);
        continue;
      }

      const existing = traderStats.get(signerAddress) ?? {
        walletAddress: signerAddress,
        tokenVolumeUsd: 0,
        tokenTradeCount: 0,
      };

      existing.tokenVolumeUsd += tradeVolumeUsd;
      existing.tokenTradeCount += 1;
      if (!existing.lastTradeAt && typeof signature.blockTime === 'number') {
        existing.lastTradeAt = new Date(signature.blockTime * 1000).toISOString();
      }

      traderStats.set(signerAddress, existing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[SCOUT] Ueberspringe Kandidaten-TX ${signature.signature.slice(0, 8)} wegen Fehler: ${message}`);
    }

    await sleep(250);
  }

  return [...traderStats.values()]
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
    })
    .slice(0, TOP_TRADERS_PER_TOKEN);
}

async function evaluateWhaleCandidate(
  connection: Connection,
  walletAddress: string,
  solUsdPrice: number,
): Promise<ScoutCandidateStats | null> {
  let walletPubKey: PublicKey;
  try {
    walletPubKey = new PublicKey(walletAddress);
  } catch {
    return null;
  }

  const signatures = await connection.getSignaturesForAddress(walletPubKey, { limit: env.SCOUT_WHALE_SIGNATURE_LIMIT });
  const cutoffTimestampSec = Math.floor(Date.now() / 1000) - (env.SCOUT_WHALE_LOOKBACK_HOURS * 60 * 60);
  let estimatedVolumeUsd = 0;
  let qualifyingTradeCount = 0;
  let lastTradeAt: string | undefined;
  const distinctTokenMints = new Set<string>();

  for (const signature of signatures) {
    if (typeof signature.blockTime === 'number' && signature.blockTime < cutoffTimestampSec) {
      break;
    }

    try {
      const tx = await connection.getParsedTransaction(signature.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) {
        await sleep(250);
        continue;
      }

      const tradedMints = getWalletTradedMints(tx, walletAddress);
      if (tradedMints.length === 0) {
        await sleep(250);
        continue;
      }

      const solDelta = getWalletNativeSolDelta(tx, walletAddress);
      const tradeVolumeUsd = solDelta === null ? 0 : Math.abs(solDelta) * solUsdPrice;
      if (!Number.isFinite(tradeVolumeUsd) || tradeVolumeUsd <= 0) {
        await sleep(250);
        continue;
      }

      estimatedVolumeUsd += tradeVolumeUsd;
      qualifyingTradeCount += 1;
      tradedMints.forEach((mint) => distinctTokenMints.add(mint));
      if (!lastTradeAt && typeof signature.blockTime === 'number') {
        lastTradeAt = new Date(signature.blockTime * 1000).toISOString();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[SCOUT] Wallet-Pruefung fuer ${walletAddress.slice(0, 8)} fehlgeschlagen: ${message}`);
    }

    await sleep(250);
  }

  return {
    estimatedVolumeUsd,
    qualifyingTradeCount,
    distinctTokenCount: distinctTokenMints.size,
    lookbackHours: env.SCOUT_WHALE_LOOKBACK_HOURS,
    ...(lastTradeAt ? { lastTradeAt } : {}),
  };
}

async function scout() {
  console.log('[SCOUT] Starte Whale-Suche ueber migrierte Seed-Tokens...');
  updateRuntimeStatus('scout', {
    lastRunAt: new Date().toISOString(),
    state: 'running',
  });
  try {
    const connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });

    const response = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
    if (!response.ok) {
      throw new Error(`Dexscreener token boosts request failed with ${response.status}`);
    }

    const rawTokens = await response.json();
    const tokens = Array.isArray(rawTokens) ? rawTokens as DexBoostToken[] : [];
    const boostedSolanaTokens = tokens
      .filter((token): token is DexBoostToken & { tokenAddress: string } => token.chainId === 'solana' && isLikelySolanaMintAddress(token.tokenAddress))
      .sort((left, right) => getBoostWeight(right) - getBoostWeight(left))
      .slice(0, env.SCOUT_BOOST_TOKEN_LIMIT);

    if (boostedSolanaTokens.length === 0) {
      updateRuntimeStatus('scout', {
        state: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastAddedCount: 0,
        whaleCount: normalizeWhales(readJsonFileSync(WHALE_FILE, [])).length,
      });
      return;
    }
    const currentWhales = normalizeWhales(readJsonFileSync(WHALE_FILE, []));
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
    let migratedSeedCount = 0;

    for (const token of boostedSolanaTokens) {
      if (addedCount >= MAX_NEW_WHALES_PER_RUN || evaluatedCandidates.size >= MAX_CANDIDATES_PER_RUN) {
        break;
      }

      const mintAddress = token.tokenAddress;
      const migratedSeed = await checkMigratedScoutSeed(mintAddress);
      if (!migratedSeed.eligible) {
        console.log(`[SCOUT] Ueberspringe Seed ${mintAddress}: ${migratedSeed.reason}.`);
        updateRuntimeStatus('scout', {
          lastSkippedSeedToken: mintAddress,
          lastSkippedSeedReason: migratedSeed.reason,
        });
        continue;
      }

      migratedSeedCount += 1;
      updateRuntimeStatus('scout', {
        lastToken: mintAddress,
        lastMigratedSeedToken: mintAddress,
        lastMigratedSeedReason: migratedSeed.reason,
      });

      console.log(`[SCOUT] Pruefe Top-${TOP_TRADERS_PER_TOKEN}-Trader ueber migrierten Token ${mintAddress} (${migratedSeed.reason})...`);
      const topTokenTraders = await collectTopTokenTraders(connection, mintAddress, solUsdPrice);

      for (let traderIndex = 0; traderIndex < topTokenTraders.length; traderIndex += 1) {
        const trader = topTokenTraders[traderIndex]!;
        if (addedCount >= MAX_NEW_WHALES_PER_RUN || evaluatedCandidates.size >= MAX_CANDIDATES_PER_RUN) {
          break;
        }

        const walletAddress = trader.walletAddress;

        if (knownWhales.has(walletAddress) || evaluatedCandidates.has(walletAddress)) {
          continue;
        }

        evaluatedCandidates.add(walletAddress);
        const candidateStats = await evaluateWhaleCandidate(connection, walletAddress, solUsdPrice);
        if (!candidateStats) {
          continue;
        }

        if (!qualifiesAsEstablishedWhale(candidateStats)) {
          console.log(`[SCOUT] Verwerfe ${walletAddress.slice(0, 8)}: Vol $${candidateStats.estimatedVolumeUsd.toFixed(0)}, Trades ${candidateStats.qualifyingTradeCount}, Tokens ${candidateStats.distinctTokenCount}.`);
          continue;
        }

        const discoveredAt = new Date().toISOString();
        const newWhale: WhaleRecord = {
          address: walletAddress,
          mode: 'paper',
          discoveredAt,
          promotedAt: null,
          paperTrades: 0,
          liveTrades: 0,
          estimatedVolumeUsd: Math.round(candidateStats.estimatedVolumeUsd),
          qualifyingTradeCount: candidateStats.qualifyingTradeCount,
          distinctTokenCount: candidateStats.distinctTokenCount,
          lastScoutedAt: discoveredAt,
          lastScoutedToken: mintAddress,
          lastScoutedReason: migratedSeed.reason,
          seedTraderRank: traderIndex + 1,
          seedTokenVolumeUsd: Math.round(trader.tokenVolumeUsd),
          seedTokenTradeCount: trader.tokenTradeCount,
        };

        currentWhales.push(newWhale);
        knownWhales.add(walletAddress);
        addedCount += 1;

        console.log(`[SCOUT] Neuer etablierter Trader entdeckt: ${walletAddress} mit ca. $${candidateStats.estimatedVolumeUsd.toFixed(0)} Volumen in ${candidateStats.lookbackHours}h (Seed-Rank Volumen ~$${trader.tokenVolumeUsd.toFixed(0)} aus ${trader.tokenTradeCount} Trades).`);
        await sendTelegram(`🎯 <b>NEUER WAL GEFUNDEN</b>\nSeed-Token: <code>${mintAddress}</code>\nSeed-Status: <b>MIGRATED</b> (${migratedSeed.reason})\nSeed-Ranking: <b>Top-${TOP_TRADERS_PER_TOKEN}</b> mit ca. <b>$${trader.tokenVolumeUsd.toFixed(0)}</b> auf diesem Coin\nWallet: <code>${walletAddress}</code>\nGeschaetztes Volumen: <b>$${candidateStats.estimatedVolumeUsd.toFixed(0)}</b> in ${candidateStats.lookbackHours}h\nTrades: <b>${candidateStats.qualifyingTradeCount}</b>\nTokens: <b>${candidateStats.distinctTokenCount}</b>\nStatus: <b>PAPER</b>`, {
          dedupeKey: `scout-new-whale:${mintAddress}:${walletAddress}`,
          cooldownMs: 24 * 60 * 60 * 1000,
        });
      }
    }

    if (addedCount > 0) {
        writeJsonFileSync(WHALE_FILE, currentWhales);
        console.log(`[SCOUT] ${addedCount} neue etablierte Wale hinzugefuegt.`);
    } else {
        console.log('[SCOUT] Keine neuen qualifizierten Wale hinzugefuegt.');
    }

    updateRuntimeStatus('scout', {
      state: 'idle',
      lastSuccessAt: new Date().toISOString(),
      lastAddedCount: addedCount,
      whaleCount: currentWhales.length,
      lastToken: boostedSolanaTokens[0]?.tokenAddress,
      lastEvaluatedCandidates: evaluatedCandidates.size,
      migratedSeedCount,
      minWhaleVolumeUsd: env.SCOUT_MIN_WHALE_VOLUME_USD,
    });

  } catch (e: any) {
    console.error('Scout Fehler:', e.message);
    updateRuntimeStatus('scout', {
      state: 'error',
      lastErrorAt: new Date().toISOString(),
      lastError: e.message,
    });
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
