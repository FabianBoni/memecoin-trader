import BN from "bn.js";
import * as pumpSwapSdk from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { env, getHeliusRpcUrl } from "../config/env.js";
import { loadTradePlans } from "../storage/trades.js";
import type { TradePlan } from "../types/trade.js";
import { ExecutionGateService } from "./execution-gate.js";
import type { PreparedExecution } from "./raydium-execution.js";
import { loadExecutionWallet } from "../wallet.js";

const DIRECT_EXECUTION_COMPUTE_UNIT_LIMIT = 450_000;

type PumpSwapModule = typeof import("@pump-fun/pump-swap-sdk");
type PumpOnlineAmmSdkCtor = PumpSwapModule["OnlinePumpAmmSdk"];
type PumpOnlineAmmSdkInstance = InstanceType<PumpOnlineAmmSdkCtor>;
type PumpAmmSdkInstance = PumpSwapModule["PUMP_AMM_SDK"];
type PumpBuyQuoteInput = PumpSwapModule["buyQuoteInput"];
type PumpSellBaseInput = PumpSwapModule["sellBaseInput"];

function resolvePumpSwapExport<K extends keyof PumpSwapModule>(exportName: K): NonNullable<PumpSwapModule[K]> {
  const moduleExports = pumpSwapSdk as PumpSwapModule & {
    default?: Partial<Record<keyof PumpSwapModule, unknown>>;
  };
  const resolved =
    moduleExports[exportName] ??
    (moduleExports.default?.[exportName] as PumpSwapModule[K] | undefined);

  if (resolved === undefined || resolved === null) {
    throw new Error(
      `@pump-fun/pump-swap-sdk is missing export ${String(exportName)}. Reinstall dependencies on the server with the locked package versions.`,
    );
  }

  return resolved as NonNullable<PumpSwapModule[K]>;
}

function getPumpAmmSdk(): PumpAmmSdkInstance {
  return resolvePumpSwapExport("PUMP_AMM_SDK");
}

function getPumpBuyQuoteInput(): PumpBuyQuoteInput {
  return resolvePumpSwapExport("buyQuoteInput");
}

function getPumpSellBaseInput(): PumpSellBaseInput {
  return resolvePumpSwapExport("sellBaseInput");
}

function solToLamports(sol: number): BN {
  return new BN(Math.round(sol * 1_000_000_000));
}

function slippageBpsToPct(slippageBps: number): number {
  return Math.max(0.1, slippageBps / 100);
}

function buildPriorityFeeInstructions(priorityFeeLamports?: number) {
  if (priorityFeeLamports === undefined || !Number.isFinite(priorityFeeLamports) || priorityFeeLamports <= 0) {
    return [];
  }

  const microLamports = Math.max(
    1,
    Math.ceil((priorityFeeLamports * 1_000_000) / DIRECT_EXECUTION_COMPUTE_UNIT_LIMIT),
  );

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: DIRECT_EXECUTION_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

function buildWarnings(dryRun: boolean): string[] {
  return dryRun
    ? ["DRY_RUN is enabled: transaction was built and signed locally but will not be broadcast."]
    : [];
}

export class PumpAmmExecutionService {
  private readonly gate = new ExecutionGateService();
  private readonly connection = new Connection(getHeliusRpcUrl(), "confirmed");
  private sdk: PumpOnlineAmmSdkInstance | null = null;

  private getOnlineSdk(): PumpOnlineAmmSdkInstance {
    if (!this.sdk) {
      const OnlinePumpAmmSdk = resolvePumpSwapExport("OnlinePumpAmmSdk");
      this.sdk = new OnlinePumpAmmSdk(this.connection);
    }

    return this.sdk;
  }

  private async buildQuoteContext(plan: TradePlan) {
    await this.gate.assertExecutable(plan);

    if (!plan.poolAddress) {
      throw new Error(`Plan ${plan.planId} is missing poolAddress.`);
    }

    const wallet = loadExecutionWallet();
    const owner = wallet.publicKey;
    const tokenMint = new PublicKey(plan.tokenAddress);
    const poolKey = new PublicKey(plan.poolAddress);
    const swapState = await this.getOnlineSdk().swapSolanaState(poolKey, owner);
    const slippagePct = slippageBpsToPct(plan.maxSlippageBps);
    const quoteInLamports = solToLamports(plan.finalPositionSol);

    if (swapState.pool.baseMint.equals(tokenMint) && swapState.pool.quoteMint.equals(NATIVE_MINT)) {
      const quote = getPumpBuyQuoteInput()({
        quote: quoteInLamports,
        slippage: slippagePct,
        baseReserve: swapState.poolBaseAmount,
        quoteReserve: swapState.poolQuoteAmount,
        globalConfig: swapState.globalConfig,
        baseMintAccount: swapState.baseMintAccount,
        baseMint: swapState.baseMint,
        coinCreator: swapState.pool.coinCreator,
        creator: swapState.pool.creator,
        feeConfig: swapState.feeConfig,
      });

      return {
        wallet,
        owner,
        swapState,
        slippagePct,
        quoteInLamports,
        inputMint: NATIVE_MINT,
        outputMint: tokenMint,
        amountOutRaw: quote.base.toString(),
        minAmountOutRaw: quote.base.toString(),
        swapSide: "buy-quote" as const,
      };
    }

    if (swapState.pool.baseMint.equals(NATIVE_MINT) && swapState.pool.quoteMint.equals(tokenMint)) {
      const quote = getPumpSellBaseInput()({
        base: quoteInLamports,
        slippage: slippagePct,
        baseReserve: swapState.poolBaseAmount,
        quoteReserve: swapState.poolQuoteAmount,
        globalConfig: swapState.globalConfig,
        baseMintAccount: swapState.baseMintAccount,
        baseMint: swapState.baseMint,
        coinCreator: swapState.pool.coinCreator,
        creator: swapState.pool.creator,
        feeConfig: swapState.feeConfig,
      });

      return {
        wallet,
        owner,
        swapState,
        slippagePct,
        quoteInLamports,
        inputMint: NATIVE_MINT,
        outputMint: tokenMint,
        amountOutRaw: quote.uiQuote.toString(),
        minAmountOutRaw: quote.minQuote.toString(),
        swapSide: "sell-base" as const,
      };
    }

    throw new Error(
      `Pump AMM pool ${plan.poolAddress} does not expose a SOL/token orientation for ${plan.tokenAddress}.`,
    );
  }

  async getPlan(planId: string): Promise<TradePlan> {
    const plans = await loadTradePlans();
    const plan = plans.find((item) => item.planId === planId);
    if (!plan) {
      throw new Error(`Trade plan not found: ${planId}`);
    }
    return plan;
  }

  async prepareExecution(planId: string, options?: { priorityFeeLamports?: number }): Promise<PreparedExecution> {
    const plan = await this.getPlan(planId);
    return this.prepareExecutionForPlan(plan, options);
  }

  async quoteForPlan(plan: TradePlan): Promise<PreparedExecution["quote"]> {
    const quoteContext = await this.buildQuoteContext(plan);

    return {
      inputMint: quoteContext.inputMint.toBase58(),
      outputMint: quoteContext.outputMint.toBase58(),
      amountInRaw: quoteContext.quoteInLamports.toString(),
      amountOutRaw: quoteContext.amountOutRaw,
      minAmountOutRaw: quoteContext.minAmountOutRaw,
    };
  }

  async prepareExecutionForPlan(plan: TradePlan, options?: { priorityFeeLamports?: number }): Promise<PreparedExecution> {
    const quoteContext = await this.buildQuoteContext(plan);
    const pumpAmmSdk = getPumpAmmSdk();
    const swapInstructions = quoteContext.swapSide === "buy-quote"
      ? await pumpAmmSdk.buyQuoteInput(quoteContext.swapState, quoteContext.quoteInLamports, quoteContext.slippagePct)
      : await pumpAmmSdk.sellBaseInput(quoteContext.swapState, quoteContext.quoteInLamports, quoteContext.slippagePct);

    const allInstructions = [
      ...buildPriorityFeeInstructions(options?.priorityFeeLamports),
      ...swapInstructions,
    ];
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const messageV0 = new TransactionMessage({
      payerKey: quoteContext.owner,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([quoteContext.wallet]);

    return {
      plan,
      ownerPublicKey: quoteContext.owner.toBase58(),
      rpcUrl: getHeliusRpcUrl(),
      dryRun: env.DRY_RUN,
      executionMode: "pumpfun-amm",
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      warnings: buildWarnings(env.DRY_RUN),
      quote: {
        inputMint: quoteContext.inputMint.toBase58(),
        outputMint: quoteContext.outputMint.toBase58(),
        amountInRaw: quoteContext.quoteInLamports.toString(),
        amountOutRaw: quoteContext.amountOutRaw,
        minAmountOutRaw: quoteContext.minAmountOutRaw,
      },
      instructionsSummary: allInstructions.map((ix, index) => `ix[${index}] program=${ix.programId.toBase58()} dataLen=${ix.data.length}`),
      serializedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    };
  }
}