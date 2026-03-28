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

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface ExecutionReceipt {
  txid?: string;
  confirmed: boolean;
  quote: Awaited<ReturnType<JupiterClient["getQuote"]>>;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount?: string;
  inputAmountUi?: number;
  outputAmountUi?: number;
  nativeSolDelta?: number;
  fillPriceSol?: number;
  fillPriceUsd?: number;
  priceSource: "receipt" | "fallback-quote";
}

type JupiterQuoteResponse = Awaited<ReturnType<JupiterClient["getQuote"]>>;

function solToLamportsString(sol: number): string {
  return String(Math.round(sol * 1_000_000_000));
}

function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

function amountToUiAmount(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function getEffectiveMaxSlippageBps(plan: TradePlan, isSellOrder: boolean): number {
  const requestedSlippage = typeof plan.maxSlippageBps === "number" && Number.isFinite(plan.maxSlippageBps)
    ? plan.maxSlippageBps
    : (isSellOrder ? env.MAX_JUPITER_SELL_SLIPPAGE_BPS : env.MAX_JUPITER_BUY_SLIPPAGE_BPS);

  const hardCap = isSellOrder ? env.MAX_JUPITER_SELL_SLIPPAGE_BPS : env.MAX_JUPITER_BUY_SLIPPAGE_BPS;
  return Math.min(requestedSlippage, hardCap);
}

function validateJupiterQuote(params: {
  quote: JupiterQuoteResponse;
  effectiveMaxSlippageBps: number;
  isSellOrder: boolean;
  tokenAddress: string;
}) {
  if (params.quote.slippageBps > params.effectiveMaxSlippageBps) {
    throw new Error(
      `Trade aborted: Quote slippage ${params.quote.slippageBps} bps exceeds hard limit ${params.effectiveMaxSlippageBps} bps.`,
    );
  }

  const routeHops = params.quote.routePlan?.length ?? 0;
  if (routeHops > env.MAX_JUPITER_ROUTE_HOPS) {
    throw new Error(
      `Trade aborted: Jupiter route uses ${routeHops} hops for ${params.tokenAddress}, above safety limit ${env.MAX_JUPITER_ROUTE_HOPS}.`,
    );
  }

  const priceImpactPct = Number(params.quote.priceImpactPct);
  if (Number.isFinite(priceImpactPct) && priceImpactPct > env.MAX_JUPITER_PRICE_IMPACT_PCT) {
    throw new Error(
      `Trade aborted: Price impact ${priceImpactPct.toFixed(2)}% exceeds safety limit ${env.MAX_JUPITER_PRICE_IMPACT_PCT}%.`,
    );
  }

  const worstCaseOutput = Number(params.quote.otherAmountThreshold);
  const expectedOutput = Number(params.quote.outAmount);
  if (Number.isFinite(worstCaseOutput) && Number.isFinite(expectedOutput) && expectedOutput > 0) {
    const worstCaseHaircutPct = ((expectedOutput - worstCaseOutput) / expectedOutput) * 100;
    if (worstCaseHaircutPct > env.MAX_JUPITER_PRICE_IMPACT_PCT && !params.isSellOrder) {
      throw new Error(
        `Trade aborted: Worst-case output haircut ${worstCaseHaircutPct.toFixed(2)}% exceeds safety limit ${env.MAX_JUPITER_PRICE_IMPACT_PCT}% on buy route.`,
      );
    }
  }
}

async function fetchSolUsdPrice(): Promise<number | null> {
  try {
    const response = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`);
    const data = await response.json();
    const price = Number(data?.data?.[SOL_MINT]?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function getParsedTransactionWithRetry(connection: Connection, signature: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const parsed = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (parsed) {
      return parsed;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return null;
}

function isBlockheightExceededError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("block height exceeded");
}

function getAccountKeyString(accountKey: unknown): string | undefined {
  if (!accountKey) {
    return undefined;
  }

  if (typeof accountKey === "string") {
    return accountKey;
  }

  if (typeof accountKey === "object" && accountKey !== null) {
    const maybePubkey = "pubkey" in accountKey ? (accountKey as { pubkey?: unknown }).pubkey : accountKey;
    if (typeof maybePubkey === "string") {
      return maybePubkey;
    }

    if (typeof maybePubkey === "object" && maybePubkey !== null && "toBase58" in maybePubkey) {
      const toBase58 = (maybePubkey as { toBase58?: () => string }).toBase58;
      if (typeof toBase58 === "function") {
        return toBase58.call(maybePubkey);
      }
    }
  }

  return undefined;
}

function getWalletNativeSolDelta(parsedTx: Awaited<ReturnType<Connection["getParsedTransaction"]>>, walletAddress: string): number | undefined {
  const accountKeys = (parsedTx?.transaction.message as { accountKeys?: unknown[] } | undefined)?.accountKeys;
  const walletIndex = accountKeys?.findIndex((accountKey) => getAccountKeyString(accountKey) === walletAddress) ?? -1;

  if (walletIndex < 0) {
    return undefined;
  }

  const preBalance = parsedTx?.meta?.preBalances?.[walletIndex];
  const postBalance = parsedTx?.meta?.postBalances?.[walletIndex];

  if (preBalance === undefined || postBalance === undefined) {
    return undefined;
  }

  return lamportsToSol(postBalance - preBalance);
}

function getTokenDelta(params: {
  parsedTx: Awaited<ReturnType<Connection["getParsedTransaction"]>>;
  walletAddress: string;
  mint: string;
}) {
  const postBalances = params.parsedTx?.meta?.postTokenBalances?.filter(
    (balance) => balance.owner === params.walletAddress && balance.mint === params.mint,
  ) ?? [];
  const preBalances = params.parsedTx?.meta?.preTokenBalances?.filter(
    (balance) => balance.owner === params.walletAddress && balance.mint === params.mint,
  ) ?? [];

  const postRaw = postBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const preRaw = preBalances.reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  const deltaRaw = postRaw - preRaw;
  const decimals = postBalances[0]?.uiTokenAmount.decimals ?? preBalances[0]?.uiTokenAmount.decimals ?? 0;

  return {
    deltaRaw,
    decimals,
    deltaUi: deltaRaw !== 0n ? amountToUiAmount(deltaRaw < 0n ? -deltaRaw : deltaRaw, decimals) : undefined,
  };
}

async function buildExecutionReceipt(params: {
  connection: Connection;
  signature: string;
  walletAddress: string;
  quote: JupiterQuoteResponse;
  inputMint: string;
  outputMint: string;
}): Promise<ExecutionReceipt> {
  const parsedTx = await getParsedTransactionWithRetry(params.connection, params.signature);

  if (!parsedTx) {
    return {
      txid: params.signature,
      confirmed: false,
      quote: params.quote,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.quote.inAmount,
      outputAmount: params.quote.outAmount,
      priceSource: "fallback-quote",
    };
  }

  const walletAddress = params.walletAddress;
  const nativeSolDelta = getWalletNativeSolDelta(parsedTx, walletAddress);
  const outputTokenDelta = params.outputMint === SOL_MINT
    ? { deltaRaw: 0n, deltaUi: undefined }
    : getTokenDelta({ parsedTx, walletAddress, mint: params.outputMint });
  const inputTokenDelta = params.inputMint === SOL_MINT
    ? { deltaRaw: 0n, deltaUi: undefined }
    : getTokenDelta({ parsedTx, walletAddress, mint: params.inputMint });

  const outputAmountUi = params.outputMint === SOL_MINT
    ? (nativeSolDelta !== undefined && nativeSolDelta > 0 ? nativeSolDelta : undefined)
    : outputTokenDelta.deltaUi;
  const outputAmountRaw = params.outputMint === SOL_MINT
    ? (nativeSolDelta !== undefined && nativeSolDelta > 0 ? String(Math.round(nativeSolDelta * 1_000_000_000)) : params.quote.outAmount)
    : (outputTokenDelta.deltaRaw > 0n ? outputTokenDelta.deltaRaw.toString() : params.quote.outAmount);
  const inputAmountUi = params.inputMint === SOL_MINT
    ? (nativeSolDelta !== undefined && nativeSolDelta < 0 ? Math.abs(nativeSolDelta) : lamportsToSol(Number(params.quote.inAmount)))
    : inputTokenDelta.deltaUi;

  let fillPriceSol: number | undefined;
  if (params.inputMint === SOL_MINT && inputAmountUi && outputAmountUi && outputAmountUi > 0) {
    fillPriceSol = inputAmountUi / outputAmountUi;
  } else if (params.outputMint === SOL_MINT && inputAmountUi && inputAmountUi > 0 && outputAmountUi && outputAmountUi > 0) {
    fillPriceSol = outputAmountUi / inputAmountUi;
  }

  const solUsdPrice = fillPriceSol !== undefined ? await fetchSolUsdPrice() : null;

  return {
    txid: params.signature,
    confirmed: true,
    quote: params.quote,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inputAmount: params.quote.inAmount,
    outputAmount: outputAmountRaw,
    priceSource: "receipt",
    ...(inputAmountUi !== undefined ? { inputAmountUi } : {}),
    ...(outputAmountUi !== undefined ? { outputAmountUi } : {}),
    ...(nativeSolDelta !== undefined ? { nativeSolDelta } : {}),
    ...(fillPriceSol !== undefined ? { fillPriceSol } : {}),
    ...(fillPriceSol !== undefined && solUsdPrice ? { fillPriceUsd: fillPriceSol * solUsdPrice } : {}),
  };
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

export async function executeJupiter(plan: TradePlan): Promise<ExecutionReceipt | undefined> {
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

  if (typeof plan.maxSlippageBps === "number" && plan.maxSlippageBps <= 0) {
    throw new Error(`Plan ${plan.planId} has invalid maxSlippageBps.`);
  }

  // --- START DUAL MODE (KAUFEN & VERKAUFEN) ---
  const anyPlan = plan as any;
  const isSellOrder = anyPlan.inputMint && anyPlan.inputMint !== SOL_MINT;

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

  const quoteInputMint = anyPlan.inputMint || SOL_MINT;
  const quoteOutputMint = anyPlan.outputMint || plan.tokenAddress;

  // Nimm die rohe Zahl (amount) beim Verkaufen, sonst rechne SOL in Lamports um beim Kaufen
  const quoteAmount = anyPlan.amount ? String(anyPlan.amount) : solToLamportsString(plan.finalPositionSol);
  const effectiveMaxSlippageBps = getEffectiveMaxSlippageBps(plan, Boolean(isSellOrder));

  const quote = await jupiter.getQuote({
    inputMint: quoteInputMint,
    outputMint: quoteOutputMint,
    amount: quoteAmount,
    slippageBps: effectiveMaxSlippageBps,
  });
  // --- END DUAL MODE ---

  validateJupiterQuote({
    quote,
    effectiveMaxSlippageBps,
    isSellOrder: Boolean(isSellOrder),
    tokenAddress: plan.tokenAddress,
  });

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
      try {
        if (swap.lastValidBlockHeight !== undefined) {
          await connection.confirmTransaction({
            signature: txid,
            blockhash: transaction.message.recentBlockhash,
            lastValidBlockHeight: swap.lastValidBlockHeight,
          }, "confirmed");
        } else {
          await connection.confirmTransaction(txid, "confirmed");
        }
      } catch (confirmError) {
        if (!isBlockheightExceededError(confirmError)) {
          throw confirmError;
        }

        const landedReceipt = await buildExecutionReceipt({
          connection,
          signature: txid,
          walletAddress: wallet.publicKey.toBase58(),
          quote,
          inputMint: quoteInputMint,
          outputMint: quoteOutputMint,
        });

        if (landedReceipt.confirmed) {
          console.warn(`Confirmation window expired for ${txid}, but the transaction was found on-chain.`);
          console.log("🚀 Transaction sent! TXID:", txid);
          console.log("🔗 View on Solscan: https://solscan.io/tx/" + txid);
          return landedReceipt;
        }

        throw confirmError;
      }
      console.log("🚀 Transaction sent! TXID:", txid);
      console.log("🔗 View on Solscan: https://solscan.io/tx/" + txid);
      return await buildExecutionReceipt({
        connection,
        signature: txid,
        walletAddress: wallet.publicKey.toBase58(),
        quote,
        inputMint: quoteInputMint,
        outputMint: quoteOutputMint,
      });
    } catch (e) {
      console.error("Broadcast failed:", e);
      throw e;
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
