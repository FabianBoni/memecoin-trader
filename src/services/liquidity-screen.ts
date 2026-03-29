import { DexscreenerClient } from "../clients/dexscreener.js";
import { HeliusClient } from "../clients/helius.js";
import { getKnownLockerLabel } from "../solana/lockers.js";
import { discoverCandidatePools } from "../solana/pools.js";
import { decodePumpAmmPool, isRecognizedPumpAmmPool } from "../solana/pump-amm.js";
import {
  decodePumpBondingCurve,
  deriveCanonicalPumpPoolAddress,
  derivePumpBondingCurveAddresses,
  getPumpAmmProgramId,
  getPumpProgramId,
} from "../solana/pumpfun.js";
import { decodeRaydiumPoolState, isRaydiumAmmV4Owner } from "../solana/raydium.js";
import type { LiquidityCheckResult, LiquidityPoolDiscovery, PumpFunCheckResult } from "../types/token.js";

function percentOf(total: bigint, part: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 10000n) / total) / 100;
}

function parseBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  return BigInt(value);
}

function pickBestPool(pools: LiquidityPoolDiscovery[]): LiquidityPoolDiscovery | undefined {
  return pools[0];
}

function classifySupplyLock(totalSupply: bigint, burned: bigint, locked: bigint): {
  passed: boolean;
  burnedPct: number;
  lockedPct: number;
  unlocked: bigint;
} {
  const cappedBurned = burned > totalSupply ? totalSupply : burned;
  const cappedLocked = locked > totalSupply ? totalSupply : locked;
  const combined = cappedBurned + cappedLocked > totalSupply ? totalSupply : cappedBurned + cappedLocked;
  const unlocked = totalSupply - combined;

  return {
    passed: unlocked === 0n && totalSupply > 0n,
    burnedPct: percentOf(totalSupply, cappedBurned),
    lockedPct: percentOf(totalSupply, cappedLocked),
    unlocked,
  };
}

export class LiquidityScreenService {
  constructor(
    private readonly heliusClient = new HeliusClient(),
    private readonly dexscreenerClient = new DexscreenerClient(),
  ) {}

  private async detectPumpFunState(tokenAddress: string, evidence: string[]): Promise<PumpFunCheckResult> {
    const bondingCurveAddresses = derivePumpBondingCurveAddresses(tokenAddress);
    const canonicalPoolAddress = deriveCanonicalPumpPoolAddress(tokenAddress);

    for (const bondingCurveAddress of bondingCurveAddresses) {
      try {
        const rawAccount = await this.heliusClient.getRawAccountInfo(bondingCurveAddress);
        if (rawAccount.owner !== getPumpProgramId()) {
          evidence.push(`Bonding curve candidate ${bondingCurveAddress} owner ${rawAccount.owner} did not match Pump program.`);
          continue;
        }

        const state = decodePumpBondingCurve(rawAccount);
        evidence.push(`Pump bonding curve detected at ${bondingCurveAddress}. complete=${String(state.complete)}.`);

        if (!state.complete) {
          return {
            detected: true,
            bondingCurveAddress,
            canonicalPoolAddress,
            status: "bonding-curve-live",
            canonicalPoolDetected: false,
            complete: false,
            reasons: ["Token is still on the Pump.fun bonding curve and has not migrated to AMM liquidity."],
            evidence: [...evidence],
          };
        }

        let canonicalPoolDetected = false;
        try {
          const canonicalPoolRaw = await this.heliusClient.getRawAccountInfo(canonicalPoolAddress);
          const canonicalPool = await decodePumpAmmPool(canonicalPoolAddress, canonicalPoolRaw);
          canonicalPoolDetected = isRecognizedPumpAmmPool(canonicalPoolRaw);
          if (canonicalPoolDetected) {
            evidence.push(`Pump AMM canonical pool detected at ${canonicalPoolAddress}.`);
          }
        } catch {
          // canonical pool may not exist yet
        }

        return {
          detected: true,
          bondingCurveAddress,
          canonicalPoolAddress,
          canonicalPoolDetected,
          status: "migrated",
          complete: true,
          reasons: [],
          evidence: [...evidence],
        };
      } catch {
        // Try next PDA.
      }
    }

    return {
      detected: false,
      canonicalPoolAddress,
      canonicalPoolDetected: false,
      status: "not-pump",
      reasons: [],
      evidence: [...evidence],
    };
  }

  private async resolveLpMintAddress(pool: LiquidityPoolDiscovery, tokenAddress: string, evidence: string[]): Promise<string | undefined> {
    if (pool.lpMintAddress) {
      return pool.lpMintAddress;
    }

    const rawAccount = await this.heliusClient.getRawAccountInfo(pool.pairAddress);

    if (pool.dexId === "pumpfun-amm") {
      const decodedPumpPool = await decodePumpAmmPool(pool.pairAddress, rawAccount);
      if (!decodedPumpPool.discriminatorMatched || rawAccount.owner !== getPumpAmmProgramId()) {
        evidence.push("Pump.fun canonical pool account was not recognized as a valid Pump AMM pool.");
        return undefined;
      }

      evidence.push("Pump.fun AMM migrated pool recognized, but manual LP mint decoding is not implemented yet. Failing closed.");
      return undefined;
    }

    if (!isRaydiumAmmV4Owner(rawAccount.owner)) {
      evidence.push(`Pool owner ${rawAccount.owner} is not a recognized Raydium AMM v4 program.`);
      return undefined;
    }

    const decoded = decodeRaydiumPoolState(rawAccount);
    evidence.push(`Decoded Raydium v4 pool state for ${pool.pairAddress}.`);
    evidence.push(`Raydium pool LP mint resolved as ${decoded.lpMint}.`);

    const tokenMatches = [decoded.baseMint, decoded.quoteMint].includes(tokenAddress);
    if (!tokenMatches) {
      evidence.push(`Resolved Raydium pool does not include target token ${tokenAddress}.`);
      return undefined;
    }

    pool.lpMintAddress = decoded.lpMint;
    return decoded.lpMint;
  }

  private async discoverLiquidityPool(tokenAddress: string, pumpFun: PumpFunCheckResult, evidence: string[]): Promise<LiquidityPoolDiscovery | undefined> {
    const pairs = await this.dexscreenerClient.searchTokenPairs(tokenAddress);
    const pools = discoverCandidatePools(tokenAddress, pairs);

    let pool = pickBestPool(pools);

    if (!pool && pumpFun.status === "migrated" && pumpFun.canonicalPoolAddress && pumpFun.canonicalPoolDetected) {
      evidence.push(`Using Pump.fun canonical migrated pool ${pumpFun.canonicalPoolAddress} as fallback pool candidate.`);
      pool = {
        pairAddress: pumpFun.canonicalPoolAddress,
        dexId: "pumpfun-amm",
        chainId: "solana",
        baseTokenAddress: tokenAddress,
        quoteTokenAddress: "So11111111111111111111111111111111111111112",
        programIdHint: getPumpAmmProgramId(),
      };
    }

    return pool;
  }

  async screenScoutSeedLiquidity(tokenAddress: string): Promise<{
    eligible: boolean;
    reason: string;
    scanAddress?: string;
    pool?: LiquidityPoolDiscovery;
    pumpFun?: PumpFunCheckResult;
    warnings: string[];
    evidence: string[];
  }> {
    const warnings: string[] = [];
    const evidence: string[] = [];

    try {
      const pumpFun = await this.detectPumpFunState(tokenAddress, evidence);

      if (pumpFun.status === "bonding-curve-live") {
        return {
          eligible: false,
          reason: "token still on bonding curve",
          pumpFun,
          warnings,
          evidence: pumpFun.evidence,
        };
      }

      const pool = await this.discoverLiquidityPool(tokenAddress, pumpFun, evidence);

      if (pumpFun.status === "migrated" && pool) {
        return {
          eligible: true,
          reason: pool.dexId ?? "pumpfun-migrated",
          scanAddress: pool.pairAddress,
          pool,
          pumpFun,
          warnings,
          evidence,
        };
      }

      if (pumpFun.status === "migrated") {
        return {
          eligible: false,
          reason: "migration detected but no AMM pool evidence",
          pumpFun,
          warnings,
          evidence,
        };
      }

      return {
        eligible: false,
        reason: `pump status ${pumpFun.status ?? "unknown"}`,
        pumpFun,
        warnings,
        evidence,
      };
    } catch (error) {
      return {
        eligible: false,
        reason: error instanceof Error ? error.message : String(error),
        warnings,
        evidence,
      };
    }
  }

  async screenLiquidity(tokenAddress: string): Promise<LiquidityCheckResult> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const evidence: string[] = [];

    const pumpFun = await this.detectPumpFunState(tokenAddress, evidence);

    if (pumpFun.status === "bonding-curve-live") {
      return {
        passed: false,
        status: "failed",
        pumpFun,
        reasons: pumpFun.reasons,
        warnings,
        evidence: pumpFun.evidence,
      };
    }

    const pool = await this.discoverLiquidityPool(tokenAddress, pumpFun, evidence);

    if (!pool) {
      return {
        passed: false,
        status: "not-found",
        pumpFun,
        reasons: ["No Solana liquidity pool discovered for token via Dexscreener or Pump.fun canonical pool."],
        warnings,
        evidence,
      };
    }

    const lpMintAddress = await this.resolveLpMintAddress(pool, tokenAddress, evidence);

    if (!lpMintAddress) {
      warnings.push("LP mint address could not be resolved for the discovered pool.");
      return {
        passed: false,
        status: "unknown",
        pool,
        pumpFun,
        reasons: ["Unable to determine LP mint address for discovered pool."],
        warnings,
        evidence,
      };
    }

    const lpMintInfo = await this.heliusClient.getParsedTokenMintInfo(lpMintAddress);
    const totalSupply = parseBigInt(lpMintInfo.supply);
    evidence.push(`LP mint ${lpMintAddress} total supply: ${totalSupply.toString()}.`);

    if (totalSupply <= 0n) {
      return {
        passed: false,
        status: "failed",
        pool,
        pumpFun,
        lpMintAddress,
        lpSupplyRaw: lpMintInfo.supply ?? "0",
        reasons: ["LP mint supply is zero or unavailable."],
        warnings,
        evidence,
      };
    }

    const burnAccounts = [
      "11111111111111111111111111111111",
      "1nc1nerator11111111111111111111111111111111",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ];

    let burned = 0n;
    for (const owner of burnAccounts) {
      const accounts = await this.heliusClient.getTokenAccountsByOwner(owner, lpMintAddress);
      for (const account of accounts) {
        const amount = parseBigInt(account.info?.tokenAmount?.amount);
        burned += amount;
        if (amount > 0n) {
          evidence.push(`Burn address ${owner} holds ${amount.toString()} LP tokens via ${account.pubkey}.`);
        }
      }
    }

    let locked = 0n;
    let lockerAddress: string | undefined;
    let lockerLabel: string | undefined;

    const candidateLockers = [pool.pairAddress];
    for (const owner of candidateLockers) {
      const label = getKnownLockerLabel(owner);
      if (!label) {
        continue;
      }

      const accounts = await this.heliusClient.getTokenAccountsByOwner(owner, lpMintAddress);
      let ownerTotal = 0n;
      for (const account of accounts) {
        const amount = parseBigInt(account.info?.tokenAmount?.amount);
        ownerTotal += amount;
        if (amount > 0n) {
          evidence.push(`Known locker ${label} (${owner}) holds ${amount.toString()} LP tokens via ${account.pubkey}.`);
        }
      }

      if (ownerTotal > 0n) {
        locked += ownerTotal;
        lockerAddress = owner;
        lockerLabel = label;
      }
    }

    const supplyState = classifySupplyLock(totalSupply, burned, locked);

    if (!supplyState.passed) {
      reasons.push("LP supply is not fully burned or locked.");
      if (supplyState.unlocked > 0n) {
        evidence.push(`Unlocked LP amount detected: ${supplyState.unlocked.toString()}.`);
      }
    }

    if (burned === 0n && locked === 0n) {
      warnings.push("No burned LP balance or recognized locker balance was found.");
    }

    const result: LiquidityCheckResult = {
      passed: supplyState.passed,
      status: supplyState.passed ? "passed" : "failed",
      pool,
      pumpFun,
      lpMintAddress,
      lpSupplyRaw: totalSupply.toString(),
      burnedLpRaw: burned.toString(),
      lockedLpRaw: locked.toString(),
      unlockedLpRaw: supplyState.unlocked.toString(),
      burnedPct: supplyState.burnedPct,
      lockedPct: supplyState.lockedPct,
      reasons,
      warnings,
      evidence,
    };

    if (lockerAddress) result.lockerAddress = lockerAddress;
    if (lockerLabel) result.lockerLabel = lockerLabel;

    return result;
  }
}
