import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { VersionedTransaction, Connection } from "@solana/web3.js";
import { env, MissingConfigError } from "../config/env.js";
import { JitoClient } from "../clients/jito.js";
import { JupiterClient } from "../clients/jupiter.js";
import { HeliusClient } from "../clients/helius.js";
import { RaydiumExecutionService } from "../services/raydium-execution.js";
import { loadTradePlans } from "../storage/trades.js";
import type { TradePlan } from "../types/trade.js";
import { loadExecutionWallet } from "../wallet.js";

function solToLamportsString(sol: number): string {
  return String(Math.round(sol * 1_000_000_000));
}

function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

function isLikelyPlanFilePath(input: string): boolean {
  return input.endsWith(".json") || input.includes("/") || input.includes("\\");
}

function loadPlanFromFile(planFilePath: string): TradePlan {
  const resolvedPath = path.resolve(process.cwd(), planFilePath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as { plan?: TradePlan };

  if (!parsed.plan) {
    throw new Error(`Plan file is missing a top-level plan object: ${resolvedPath}`);
  }

  return parsed.plan;
}

async function loadPlan(input: string): Promise<TradePlan> {
  if (isLikelyPlanFilePath(input)) {
    return loadPlanFromFile(input);
  }

  const plans = await loadTradePlans();
  const plan = plans.find((item) => item.planId === input);
  if (!plan) {
    throw new Error(`Trade plan not found: ${input}`);
  }

  return plan;
}

export async function executeJupiter(plan: TradePlan) {
  if (plan.executionMode !== "jupiter") {
    throw new Error(`Plan ${plan.planId} is not marked for jupiter execution.`);
  }

  const wallet = loadExecutionWallet();
  console.log("Loaded execution wallet public key:", wallet.publicKey.toBase58());

  const jupiter = new JupiterClient();
  const helius = new HeliusClient();
  const priorityFeeLamports = await helius.getPriorityFeeEstimate([plan.tokenAddress]);
  const priorityFeeSol = priorityFeeLamports !== undefined ? lamportsToSol(priorityFeeLamports) : undefined;

  if (priorityFeeSol !== undefined && priorityFeeSol > env.MAX_PRIORITY_FEE_SOL) {
    throw new Error(
      `Trade aborted: Priority fee ${priorityFeeSol} exceeds safety limit ${env.MAX_PRIORITY_FEE_SOL}`,
    );
  }

  if (plan.maxSlippageBps <= 0) {
    throw new Error(`Plan ${plan.planId} has invalid maxSlippageBps.`);
  }

  // --- START DUAL MODE (KAUFEN & VERKAUFEN) ---
  const anyPlan = plan as any;
  const isSellOrder = anyPlan.inputMint && anyPlan.inputMint !== "So11111111111111111111111111111111111111112";

  // --- START EISERNER PUFFER (SOL RESERVE) ---
  if (!isSellOrder) {
    // Wir prüfen das Guthaben nur, wenn wir NEU KAUFEN wollen
    const rpcUrl = process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
    const checkConnection = new Connection(rpcUrl, "confirmed");
    
    const balanceLamports = await checkConnection.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / 1_000_000_000;
    
    // Wie viel SOL brauchen wir? (Kaufbetrag + Notgroschen für Gebühren)
    const reserveSol = parseFloat(process.env.MIN_SOL_RESERVE || "0.05");
    const requiredSol = plan.finalPositionSol + reserveSol;
    
    if (balanceSol < requiredSol) {
      throw new Error(`⚠️ NOT-HALT: Zu wenig SOL! Kontostand: ${balanceSol.toFixed(3)} SOL. Benötigt: ${requiredSol.toFixed(3)} SOL (inkl. ${reserveSol} Reserve). Trade abgebrochen, um Gebühren-Falle zu verhindern!`);
    }
  }
  // --- END EISERNER PUFFER ---

  const quoteInputMint = anyPlan.inputMint || "So11111111111111111111111111111111111111112";
  const quoteOutputMint = anyPlan.outputMint || plan.tokenAddress;

  // Nimm die rohe Zahl (amount) beim Verkaufen, sonst rechne SOL in Lamports um beim Kaufen
  const quoteAmount = anyPlan.amount ? String(anyPlan.amount) : solToLamportsString(plan.finalPositionSol);
  const quoteSlippage = plan.maxSlippageBps || (isSellOrder ? 1500 : 1000);

  const quote = await jupiter.getQuote({
    inputMint: quoteInputMint,
    outputMint: quoteOutputMint,
    amount: quoteAmount,
    slippageBps: quoteSlippage,
  });
  // --- END DUAL MODE ---

  if (quote.slippageBps > plan.maxSlippageBps) {
    console.warn(`Quote slippage ${quote.slippageBps} exceeds plan max slippage ${plan.maxSlippageBps}, but proceeding due to dynamic adjustments.`);
  }

  const swapParams: {
    quoteResponse: typeof quote;
    userPublicKey: string;
    priorityFeeLamports?: number;
  } = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
  };

  if (priorityFeeLamports !== undefined) {
    swapParams.priorityFeeLamports = priorityFeeLamports;
  }

  const swap = await jupiter.buildSwap(swapParams);

  const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  transaction.sign([wallet]);

  // --- START MANUAL PATCH ---
  if (!plan.dryRun) {
    console.warn("\n!!! BROADCASTING LIVE TRANSACTION !!!\n");
    const rpcUrl = process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const rawTx = transaction.serialize();

    try {
      const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: true });
      console.log("🚀 Transaction sent! TXID:", txid);
      console.log("🔗 View on Solscan: https://solscan.io/tx/" + txid);
      return; // Beendet das Skript hier, damit er unten keinen Fehler wirft
    } catch (e) {
      console.error("Broadcast failed:", e);
      return;
    }
  }
  // --- END MANUAL PATCH ---

  const heliusConnection = new RaydiumExecutionService()["connection"];
  const simulation = await heliusConnection.simulateTransaction(transaction, { sigVerify: false });

  const jitoClient = new JitoClient();
  const preparedBundle = await jitoClient.submitBundle([Buffer.from(transaction.serialize()).toString("base64")]);

  console.log(JSON.stringify({
    mode: "jupiter",
    plan,
    priorityFeeLamports,
    priorityFeeSol,
    maxPriorityFeeSol: env.MAX_PRIORITY_FEE_SOL,
    quote,
    simulation,
    preparedBundle,
  }, null, 2));
}

async function main() {
  const planInput = process.argv[2];

  if (!planInput) {
    console.error("Usage: npm run trade:execute -- <PLAN_ID|./data/plans/PLAN-123.json>");
    process.exit(1);
  }

  const plan = await loadPlan(planInput);

  if (plan.executionMode === "jupiter") {
    await executeJupiter(plan);
    return;
  }

  if (isLikelyPlanFilePath(planInput)) {
    throw new Error("Raydium execution from direct plan file is not supported yet. Use a stored planId.");
  }

  const executionService = new RaydiumExecutionService();
  const jitoClient = new JitoClient();

  const preparedExecution = await executionService.prepareExecution(planInput);
  const preparedBundle = await jitoClient.submitBundle([preparedExecution.serializedTransactionBase64]);

  console.log(JSON.stringify({ preparedExecution, preparedBundle }, null, 2));
}

// main().catch((error: unknown) => {
//  if (error instanceof MissingConfigError) {
//    console.error(`Configuration error: ${error.message}`);
//    process.exit(2);
//  }

//  const message = error instanceof Error ? error.message : "Unknown error";
//  console.error(`Trade execution failed: ${message}`);
//  process.exit(1);
// });
