import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Liquidity, Token, TokenAmount, TxVersion } from "@raydium-io/raydium-sdk";
import { env, getHeliusRpcUrl } from "../config/env.js";
import { HeliusClient } from "../clients/helius.js";
import { ExecutionGateService } from "./execution-gate.js";
import { loadTradePlans } from "../storage/trades.js";
import type { ExecutionMode, TradePlan } from "../types/trade.js";
import { getWalletTokenAccounts, getWrappedSolMint } from "../solana/token-accounts.js";
import { quoteRaydiumSwap } from "../solana/raydium-quote.js";
import { resolveRaydiumPoolKeys } from "../solana/raydium-pool-keys.js";
import { loadExecutionWallet } from "../wallet.js";

const DIRECT_EXECUTION_COMPUTE_UNIT_LIMIT = 400_000;

export interface PreparedExecution {
  plan: TradePlan;
  ownerPublicKey: string;
  rpcUrl: string;
  dryRun: boolean;
  instructionsSummary: string[];
  serializedTransactionBase64: string;
  executionMode: ExecutionMode;
  lastValidBlockHeight: number;
  warnings: string[];
  quote: {
    inputMint: string;
    outputMint: string;
    amountInRaw: string;
    amountOutRaw: string;
    minAmountOutRaw: string;
  };
}

function solToLamports(sol: number): BN {
  return new BN(Math.round(sol * 1_000_000_000));
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

export class RaydiumExecutionService {
  private readonly gate = new ExecutionGateService();
  private readonly connection = new Connection(getHeliusRpcUrl(), "confirmed");
  private readonly heliusClient = new HeliusClient();

  private async buildQuoteContext(plan: TradePlan) {
    await this.gate.assertExecutable(plan);

    if (!plan.poolAddress) {
      throw new Error(`Plan ${plan.planId} is missing poolAddress.`);
    }

    const wallet = loadExecutionWallet();
    const owner = wallet.publicKey;
    const tokenMint = new PublicKey(plan.tokenAddress);
    const inputMint = getWrappedSolMint();
    const outputMint = tokenMint;

    const { poolKeys, poolInfo } = await resolveRaydiumPoolKeys(this.heliusClient, plan.poolAddress);
    const quote = quoteRaydiumSwap({
      poolKeys,
      poolInfo,
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amountInSol: plan.finalPositionSol,
      slippageBps: plan.maxSlippageBps,
    });

    return {
      wallet,
      owner,
      poolKeys,
      inputMint,
      outputMint,
      quote,
    };
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
      amountInRaw: quoteContext.quote.amountInRaw,
      amountOutRaw: quoteContext.quote.amountOutRaw,
      minAmountOutRaw: quoteContext.quote.minAmountOutRaw,
    };
  }

  async prepareExecutionForPlan(plan: TradePlan, options?: { priorityFeeLamports?: number }): Promise<PreparedExecution> {
    const quoteContext = await this.buildQuoteContext(plan);
    const tokenAccounts = await getWalletTokenAccounts(this.heliusClient, quoteContext.owner);
    const tokenIn = new Token(quoteContext.poolKeys.programId, quoteContext.inputMint, 9);
    const tokenOut = new Token(
      quoteContext.poolKeys.programId,
      quoteContext.outputMint,
      quoteContext.poolKeys.baseMint.equals(quoteContext.outputMint)
        ? quoteContext.poolKeys.baseDecimals
        : quoteContext.poolKeys.quoteDecimals,
    );

    const amountIn = new TokenAmount(tokenIn, solToLamports(plan.finalPositionSol));
    const amountOut = new TokenAmount(tokenOut, new BN(quoteContext.quote.minAmountOutRaw));

    const built = await Liquidity.makeSwapInstructionSimple({
      connection: this.connection,
      poolKeys: quoteContext.poolKeys as any,
      userKeys: {
        tokenAccounts: tokenAccounts as any,
        owner: quoteContext.owner,
        payer: quoteContext.owner,
      },
      amountIn,
      amountOut,
      fixedSide: "in",
      config: {
        bypassAssociatedCheck: false,
        checkCreateATAOwner: true,
      },
      makeTxVersion: TxVersion.V0,
      lookupTableCache: {},
    } as any);

    const allInstructions = [
      ...buildPriorityFeeInstructions(options?.priorityFeeLamports),
      ...built.innerTransactions.flatMap((tx: any) => tx.instructions ?? []),
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
      executionMode: "raydium-sdk",
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      warnings: buildWarnings(env.DRY_RUN),
      quote: {
        inputMint: quoteContext.inputMint.toBase58(),
        outputMint: quoteContext.outputMint.toBase58(),
        amountInRaw: quoteContext.quote.amountInRaw,
        amountOutRaw: quoteContext.quote.amountOutRaw,
        minAmountOutRaw: quoteContext.quote.minAmountOutRaw,
      },
      instructionsSummary: allInstructions.map((ix, index) => `ix[${index}] program=${ix.programId.toBase58()} dataLen=${ix.data.length}`),
      serializedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    };
  }
}
