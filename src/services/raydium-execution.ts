import {
  Connection,
  Keypair,
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
import type { TradePlan } from "../types/trade.js";
import { getWalletTokenAccounts, getWrappedSolMint } from "../solana/token-accounts.js";
import { quoteRaydiumSwap } from "../solana/raydium-quote.js";
import { resolveRaydiumPoolKeys } from "../solana/raydium-pool-keys.js";

export interface PreparedExecution {
  plan: TradePlan;
  ownerPublicKey: string;
  rpcUrl: string;
  dryRun: boolean;
  instructionsSummary: string[];
  serializedTransactionBase64: string;
  executionMode: "raydium-sdk";
  warnings: string[];
  quote: {
    amountInRaw: string;
    amountOutRaw: string;
    minAmountOutRaw: string;
  };
}

function decodePrivateKey(raw: string): Uint8Array {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }

  return Uint8Array.from(Buffer.from(trimmed, "base64"));
}

function loadBurnerWallet(): Keypair {
  const privateKey = env.SOLANA_WALLET_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("Missing SOLANA_WALLET_PRIVATE_KEY for execution scaffolding.");
  }

  return Keypair.fromSecretKey(decodePrivateKey(privateKey));
}

function solToLamports(sol: number): BN {
  return new BN(Math.round(sol * 1_000_000_000));
}

export class RaydiumExecutionService {
  private readonly gate = new ExecutionGateService();
  private readonly connection = new Connection(getHeliusRpcUrl(), "confirmed");
  private readonly heliusClient = new HeliusClient();

  async getPlan(planId: string): Promise<TradePlan> {
    const plans = await loadTradePlans();
    const plan = plans.find((item) => item.planId === planId);
    if (!plan) {
      throw new Error(`Trade plan not found: ${planId}`);
    }
    return plan;
  }

  async prepareExecution(planId: string): Promise<PreparedExecution> {
    const plan = await this.getPlan(planId);
    await this.gate.assertExecutable(plan);

    if (!plan.poolAddress) {
      throw new Error(`Plan ${plan.planId} is missing poolAddress.`);
    }

    const wallet = loadBurnerWallet();
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

    const tokenAccounts = await getWalletTokenAccounts(this.heliusClient, owner);
    const tokenIn = new Token(poolKeys.programId, inputMint, 9);
    const tokenOut = new Token(poolKeys.programId, outputMint, poolKeys.baseMint.equals(outputMint) ? poolKeys.baseDecimals : poolKeys.quoteDecimals);

    const amountIn = new TokenAmount(tokenIn, solToLamports(plan.finalPositionSol));
    const amountOut = new TokenAmount(tokenOut, new BN(quote.minAmountOutRaw));

    const built = await Liquidity.makeSwapInstructionSimple({
      connection: this.connection,
      poolKeys: poolKeys as any,
      userKeys: {
        tokenAccounts: tokenAccounts as any,
        owner,
        payer: owner,
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

    const allInstructions = built.innerTransactions.flatMap((tx: any) => tx.instructions ?? []);
    const recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;
    const messageV0 = new TransactionMessage({
      payerKey: owner,
      recentBlockhash,
      instructions: allInstructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    return {
      plan,
      ownerPublicKey: owner.toBase58(),
      rpcUrl: getHeliusRpcUrl(),
      dryRun: env.DRY_RUN,
      executionMode: "raydium-sdk",
      warnings: [
        "DRY_RUN is enabled: transaction was built and signed locally but will not be broadcast.",
      ],
      quote: {
        amountInRaw: quote.amountInRaw,
        amountOutRaw: quote.amountOutRaw,
        minAmountOutRaw: quote.minAmountOutRaw,
      },
      instructionsSummary: allInstructions.map((ix, index) => `ix[${index}] program=${ix.programId.toBase58()} dataLen=${ix.data.length}`),
      serializedTransactionBase64: Buffer.from(transaction.serialize()).toString("base64"),
    };
  }
}
