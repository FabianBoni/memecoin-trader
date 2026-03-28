import BN from "bn.js";
import { Liquidity, Percent, Token, TokenAmount } from "@raydium-io/raydium-sdk";
import type { ResolvedRaydiumPoolInfo, ResolvedRaydiumPoolKeys } from "./raydium-pool-keys.js";

export interface RaydiumQuoteResult {
  amountInRaw: string;
  amountOutRaw: string;
  minAmountOutRaw: string;
  currentPrice?: string;
  executionPrice?: string;
  priceImpact?: string;
  feeRaw?: string;
}

function solToLamports(sol: number): BN {
  return new BN(Math.round(sol * 1_000_000_000));
}

export function quoteRaydiumSwap(params: {
  poolKeys: ResolvedRaydiumPoolKeys;
  poolInfo: ResolvedRaydiumPoolInfo;
  inputMint: string;
  outputMint: string;
  amountInSol: number;
  slippageBps: number;
}): RaydiumQuoteResult {
  const { poolKeys, poolInfo, inputMint, outputMint, amountInSol, slippageBps } = params;

  const tokenInDecimals = inputMint === poolKeys.baseMint.toBase58() ? poolInfo.baseDecimals : poolInfo.quoteDecimals;
  const tokenOutDecimals = outputMint === poolKeys.baseMint.toBase58() ? poolInfo.baseDecimals : poolInfo.quoteDecimals;

  const tokenIn = new Token(poolKeys.programId, inputMint, tokenInDecimals);
  const tokenOut = new Token(poolKeys.programId, outputMint, tokenOutDecimals);
  const amountInRaw = solToLamports(amountInSol);
  const amountIn = new TokenAmount(tokenIn, amountInRaw);
  const slippage = new Percent(slippageBps, 10_000);

  const quoted = Liquidity.computeAmountOut({
    poolKeys: poolKeys as any,
    poolInfo: poolInfo as any,
    amountIn,
    currencyOut: tokenOut,
    slippage,
  });

  const result: RaydiumQuoteResult = {
    amountInRaw: amountIn.raw.toString(),
    amountOutRaw: quoted.amountOut.raw.toString(),
    minAmountOutRaw: quoted.minAmountOut.raw.toString(),
  };

  if (quoted.currentPrice) result.currentPrice = quoted.currentPrice.toFixed();
  if (quoted.executionPrice) result.executionPrice = quoted.executionPrice.toFixed();
  if (quoted.priceImpact) result.priceImpact = quoted.priceImpact.toFixed();
  if (quoted.fee?.raw) result.feeRaw = quoted.fee.raw.toString();

  return result;
}
