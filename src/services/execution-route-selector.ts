import { env } from "../config/env.js";
import { JupiterClient, type JupiterQuoteResponse } from "../clients/jupiter.js";
import { PumpAmmExecutionService } from "./pump-amm-execution.js";
import { RaydiumExecutionService } from "./raydium-execution.js";
import type { ExecutionMode, TradePlan } from "../types/trade.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

type ComparableQuote = {
  inputMint: string;
  outputMint: string;
  amountInRaw: string;
  amountOutRaw: string;
  minAmountOutRaw: string;
};

export type BuyRouteCandidate = {
  executionMode: ExecutionMode;
  available: boolean;
  amountInRaw?: string;
  amountOutRaw?: string;
  minAmountOutRaw?: string;
  priceImpactPct?: number | null;
  routeHops?: number;
  reason?: string;
};

export type BuyRouteSelection = {
  preferredExecutionMode: ExecutionMode;
  executionOrder: ExecutionMode[];
  candidates: BuyRouteCandidate[];
  summary: string;
};

function solToLamportsString(sol: number): string {
  return String(Math.round(sol * 1_000_000_000));
}

function parseBigIntSafe(value?: string): bigint {
  if (!value) {
    return 0n;
  }

  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function compareBigIntDesc(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left > right ? -1 : 1;
}

function compareCandidates(left: BuyRouteCandidate, right: BuyRouteCandidate): number {
  const minDiff = compareBigIntDesc(
    parseBigIntSafe(left.minAmountOutRaw),
    parseBigIntSafe(right.minAmountOutRaw),
  );
  if (minDiff !== 0) {
    return minDiff;
  }

  const expectedDiff = compareBigIntDesc(
    parseBigIntSafe(left.amountOutRaw),
    parseBigIntSafe(right.amountOutRaw),
  );
  if (expectedDiff !== 0) {
    return expectedDiff;
  }

  if (left.executionMode === "jupiter" && right.executionMode !== "jupiter") {
    return 1;
  }

  if (right.executionMode === "jupiter" && left.executionMode !== "jupiter") {
    return -1;
  }

  return left.executionMode.localeCompare(right.executionMode);
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getJupiterGuardReason(quote: JupiterQuoteResponse, maxSlippageBps: number): string | null {
  if (quote.slippageBps > maxSlippageBps) {
    return `Jupiter quote slippage ${quote.slippageBps} bps exceeds ${maxSlippageBps} bps.`;
  }

  const routeHops = quote.routePlan?.length ?? 0;
  if (routeHops > env.MAX_JUPITER_ROUTE_HOPS) {
    return `Jupiter route uses ${routeHops} hops, above limit ${env.MAX_JUPITER_ROUTE_HOPS}.`;
  }

  const priceImpactPct = toFiniteNumber(quote.priceImpactPct);
  if (priceImpactPct !== null && priceImpactPct > env.MAX_JUPITER_PRICE_IMPACT_PCT) {
    return `Jupiter price impact ${priceImpactPct.toFixed(2)}% exceeds ${env.MAX_JUPITER_PRICE_IMPACT_PCT}%.`;
  }

  const worstCaseOutput = toFiniteNumber(quote.otherAmountThreshold);
  const expectedOutput = toFiniteNumber(quote.outAmount);
  if (worstCaseOutput !== null && expectedOutput !== null && expectedOutput > 0) {
    const worstCaseHaircutPct = ((expectedOutput - worstCaseOutput) / expectedOutput) * 100;
    if (worstCaseHaircutPct > env.MAX_JUPITER_PRICE_IMPACT_PCT) {
      return `Jupiter worst-case haircut ${worstCaseHaircutPct.toFixed(2)}% exceeds ${env.MAX_JUPITER_PRICE_IMPACT_PCT}%.`;
    }
  }

  return null;
}

function quoteToCandidate(executionMode: ExecutionMode, quote: ComparableQuote): BuyRouteCandidate {
  return {
    executionMode,
    available: true,
    amountInRaw: quote.amountInRaw,
    amountOutRaw: quote.amountOutRaw,
    minAmountOutRaw: quote.minAmountOutRaw,
  };
}

function candidateFailure(executionMode: ExecutionMode, reason: string): BuyRouteCandidate {
  return {
    executionMode,
    available: false,
    reason,
  };
}

function calculateEdgeBps(best?: BuyRouteCandidate, alternative?: BuyRouteCandidate): number | null {
  if (!best || !alternative) {
    return null;
  }

  const bestMin = parseBigIntSafe(best.minAmountOutRaw);
  const altMin = parseBigIntSafe(alternative.minAmountOutRaw);
  if (bestMin <= 0n || altMin <= 0n || bestMin <= altMin) {
    return null;
  }

  return Number(((bestMin - altMin) * 10_000n) / altMin);
}

function buildSummary(orderedCandidates: BuyRouteCandidate[], unavailableCandidates: BuyRouteCandidate[]): string {
  const best = orderedCandidates[0];
  const second = orderedCandidates[1];
  const failureSummary = unavailableCandidates
    .filter((candidate) => candidate.reason)
    .map((candidate) => `${candidate.executionMode}: ${candidate.reason}`)
    .join(" | ");

  if (!best) {
    return failureSummary || "keine belastbare Route";
  }

  if (!second) {
    return failureSummary
      ? `${best.executionMode} ist die einzige belastbare Route. ${failureSummary}`
      : `${best.executionMode} ist die einzige belastbare Route.`;
  }

  const edgeBps = calculateEdgeBps(best, second);
  const edgeLabel = edgeBps === null ? "" : ` (+${edgeBps} bps minOut)`;
  return failureSummary
    ? `${best.executionMode} vor ${second.executionMode}${edgeLabel}. ${failureSummary}`
    : `${best.executionMode} vor ${second.executionMode}${edgeLabel}.`;
}

export class BuyExecutionRouteSelector {
  private readonly jupiterClient = new JupiterClient();
  private readonly raydiumExecutionService = new RaydiumExecutionService();
  private readonly pumpAmmExecutionService = new PumpAmmExecutionService();

  private async quoteJupiterPlan(plan: TradePlan): Promise<BuyRouteCandidate> {
    const quote = await this.jupiterClient.getQuote({
      inputMint: plan.inputMint ?? SOL_MINT,
      outputMint: plan.outputMint ?? plan.tokenAddress,
      amount: plan.amount ?? solToLamportsString(plan.finalPositionSol),
      slippageBps: plan.maxSlippageBps,
    });

    const guardReason = getJupiterGuardReason(quote, plan.maxSlippageBps);
    if (guardReason) {
      return candidateFailure("jupiter", guardReason);
    }

    return {
      ...quoteToCandidate("jupiter", {
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        amountInRaw: quote.inAmount,
        amountOutRaw: quote.outAmount,
        minAmountOutRaw: quote.otherAmountThreshold,
      }),
      priceImpactPct: toFiniteNumber(quote.priceImpactPct),
      routeHops: quote.routePlan?.length ?? 0,
    };
  }

  private async quoteDirectPlan(plan: TradePlan): Promise<BuyRouteCandidate> {
    if (plan.executionMode === "raydium-sdk") {
      return quoteToCandidate(plan.executionMode, await this.raydiumExecutionService.quoteForPlan(plan));
    }

    if (plan.executionMode === "pumpfun-amm") {
      return quoteToCandidate(plan.executionMode, await this.pumpAmmExecutionService.quoteForPlan(plan));
    }

    return candidateFailure(plan.executionMode ?? "jupiter", "No direct quote path available.");
  }

  async selectBuyExecutionOrder(params: {
    jupiterPlan: TradePlan;
    directPlan?: TradePlan;
  }): Promise<BuyRouteSelection> {
    const candidates: BuyRouteCandidate[] = [];

    if (params.directPlan?.executionMode && params.directPlan.executionMode !== "jupiter") {
      try {
        candidates.push(await this.quoteDirectPlan(params.directPlan));
      } catch (error) {
        candidates.push(candidateFailure(
          params.directPlan.executionMode,
          error instanceof Error ? error.message : String(error),
        ));
      }
    }

    try {
      candidates.push(await this.quoteJupiterPlan(params.jupiterPlan));
    } catch (error) {
      candidates.push(candidateFailure(
        "jupiter",
        error instanceof Error ? error.message : String(error),
      ));
    }

    const availableCandidates = candidates
      .filter((candidate) => candidate.available)
      .sort(compareCandidates);

    if (availableCandidates.length === 0) {
      throw new Error(buildSummary([], candidates));
    }

    return {
      preferredExecutionMode: availableCandidates[0]!.executionMode,
      executionOrder: availableCandidates.map((candidate) => candidate.executionMode),
      candidates,
      summary: buildSummary(availableCandidates, candidates.filter((candidate) => !candidate.available)),
    };
  }
}