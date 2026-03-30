import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { env, MissingConfigError } from "../config/env.js";
import { JitoClient, resolveJitoTipLamports } from "../clients/jito.js";
import { JupiterClient } from "../clients/jupiter.js";
import { HeliusClient } from "../clients/helius.js";
import { PumpAmmExecutionService } from "../services/pump-amm-execution.js";
import { RaydiumExecutionService } from "../services/raydium-execution.js";
import { loadTradePlans } from "../storage/trades.js";
import type { ExecutionMode, TradePlan } from "../types/trade.js";
import { loadExecutionWallet } from "../wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const JITO_DONT_FRONT_ACCOUNT = new PublicKey("jitodontfront111111111111111111111111111111");

interface ExecutionQuoteSummary {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
}

interface ExecutionReceipt {
  txid?: string;
  confirmed: boolean;
  quote: ExecutionQuoteSummary;
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

interface AugmentedTransactionResult {
  transaction: VersionedTransaction;
  serializedTransactionBase64: string;
  tipLamports?: number;
  tipAccount?: string;
  dontFrontProtected: boolean;
  augmented: boolean;
  augmentationError?: string;
}

function solToLamportsString(sol: number): string {
  return String(Math.round(sol * 1_000_000_000));
}

function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function amountToUiAmount(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function toExecutionQuoteSummary(quote: JupiterQuoteResponse): ExecutionQuoteSummary {
  return {
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    slippageBps: quote.slippageBps,
    ...(quote.priceImpactPct !== undefined ? { priceImpactPct: quote.priceImpactPct } : {}),
    ...(quote.routePlan !== undefined ? { routePlan: quote.routePlan } : {}),
  };
}

function buildDirectQuoteSummary(params: {
  amountInRaw: string;
  amountOutRaw: string;
  minAmountOutRaw: string;
  slippageBps: number;
}): ExecutionQuoteSummary {
  return {
    inAmount: params.amountInRaw,
    outAmount: params.amountOutRaw,
    otherAmountThreshold: params.minAmountOutRaw,
    slippageBps: params.slippageBps,
    routePlan: [],
  };
}

async function resolveAddressLookupTableAccounts(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  const lookups = transaction.message.addressTableLookups ?? [];
  if (lookups.length === 0) {
    return [];
  }

  const responses = await Promise.all(
    lookups.map(async (lookup) => {
      const account = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
      if (!account.value) {
        throw new Error(`Address lookup table ${lookup.accountKey.toBase58()} was not found.`);
      }
      return account.value;
    }),
  );

  return responses;
}

function buildDontFrontInstruction(): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      {
        pubkey: JITO_DONT_FRONT_ACCOUNT,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.from("jito-dont-front"),
  });
}

function chooseRandomTipAccount(tipAccounts: string[]): string {
  const index = Math.floor(Math.random() * tipAccounts.length);
  return tipAccounts[index]!;
}

async function augmentTransactionForJito(params: {
  connection: Connection;
  jitoClient: JitoClient;
  transaction: VersionedTransaction;
  wallet: ReturnType<typeof loadExecutionWallet>;
  tipLamports?: number;
  addDontFrontProtection: boolean;
}): Promise<AugmentedTransactionResult> {
  try {
    const lookupTableAccounts = await resolveAddressLookupTableAccounts(params.connection, params.transaction);
    const message = TransactionMessage.decompile(params.transaction.message, {
      addressLookupTableAccounts: lookupTableAccounts,
    });
    const extraInstructions: TransactionInstruction[] = [];
    let tipAccount: string | undefined;

    if (params.addDontFrontProtection) {
      extraInstructions.push(buildDontFrontInstruction());
    }

    if (params.tipLamports !== undefined && params.tipLamports > 0) {
      const tipAccounts = await params.jitoClient.getTipAccounts();
      if (tipAccounts.length === 0) {
        throw new Error("Jito did not return any tip accounts.");
      }

      tipAccount = chooseRandomTipAccount(tipAccounts);
      extraInstructions.push(SystemProgram.transfer({
        fromPubkey: params.wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: params.tipLamports,
      }));
    }

    if (extraInstructions.length === 0) {
      params.transaction.sign([params.wallet]);
      return {
        transaction: params.transaction,
        serializedTransactionBase64: Buffer.from(params.transaction.serialize()).toString("base64"),
        dontFrontProtected: false,
        augmented: false,
      };
    }

    const rebuiltMessage = new TransactionMessage({
      payerKey: message.payerKey,
      recentBlockhash: message.recentBlockhash,
      instructions: [...message.instructions, ...extraInstructions],
    }).compileToV0Message(lookupTableAccounts);

    const rebuiltTransaction = new VersionedTransaction(rebuiltMessage);
    rebuiltTransaction.sign([params.wallet]);

    return {
      transaction: rebuiltTransaction,
      serializedTransactionBase64: Buffer.from(rebuiltTransaction.serialize()).toString("base64"),
      ...(params.tipLamports !== undefined ? { tipLamports: params.tipLamports } : {}),
      ...(tipAccount ? { tipAccount } : {}),
      dontFrontProtected: params.addDontFrontProtection,
      augmented: true,
    };
  } catch (error) {
    params.transaction.sign([params.wallet]);

    return {
      transaction: params.transaction,
      serializedTransactionBase64: Buffer.from(params.transaction.serialize()).toString("base64"),
      ...(params.tipLamports !== undefined ? { tipLamports: params.tipLamports } : {}),
      dontFrontProtected: false,
      augmented: false,
      augmentationError: error instanceof Error ? error.message : String(error),
    };
  }
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
  quote: ExecutionQuoteSummary;
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

async function findLandedReceiptAfterExpiry(params: {
  connection: Connection;
  signature: string;
  walletAddress: string;
  quote: ExecutionQuoteSummary;
  inputMint: string;
  outputMint: string;
}): Promise<ExecutionReceipt | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const receipt = await buildExecutionReceipt(params);
    if (receipt.confirmed) {
      return receipt;
    }

    if (attempt < 2) {
      await sleep(3_000);
    }
  }

  return null;
}

async function logJitoBundleDiagnostics(jitoClient: JitoClient, bundleId: string) {
  try {
    const inflightStatus = await jitoClient.getFirstInflightBundleStatus(bundleId);
    if (inflightStatus) {
      console.warn(`[JITO] Bundle ${bundleId} Status: ${inflightStatus.status}${inflightStatus.landedSlot !== null ? ` @ slot ${inflightStatus.landedSlot}` : ""}.`);
      return;
    }

    const landedStatuses = await jitoClient.getBundleStatuses([bundleId]);
    const landedStatus = landedStatuses[0];
    if (landedStatus) {
      console.warn(`[JITO] Bundle ${bundleId} landed im Slot ${landedStatus.slot} (${landedStatus.confirmationStatus ?? "unknown"}).`);
      return;
    }

    console.warn(`[JITO] Keine Bundle-Diagnose fuer ${bundleId} verfuegbar.`);
  } catch (error) {
    console.warn(`[JITO] Bundle-Diagnose fuer ${bundleId} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function confirmSubmittedTransaction(params: {
  connection: Connection;
  signature: string;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  walletAddress: string;
  quote: ExecutionQuoteSummary;
  inputMint: string;
  outputMint: string;
  jitoClient?: JitoClient;
  jitoBundleId?: string;
}): Promise<ExecutionReceipt> {
  try {
    if (params.lastValidBlockHeight !== undefined) {
      await params.connection.confirmTransaction({
        signature: params.signature,
        blockhash: params.recentBlockhash,
        lastValidBlockHeight: params.lastValidBlockHeight,
      }, "confirmed");
    } else {
      await params.connection.confirmTransaction(params.signature, "confirmed");
    }
  } catch (confirmError) {
    if (!isBlockheightExceededError(confirmError)) {
      if (params.jitoClient && params.jitoBundleId) {
        await logJitoBundleDiagnostics(params.jitoClient, params.jitoBundleId);
      }
      throw confirmError;
    }

    const landedReceipt = await findLandedReceiptAfterExpiry({
      connection: params.connection,
      signature: params.signature,
      walletAddress: params.walletAddress,
      quote: params.quote,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
    });

    if (landedReceipt?.confirmed) {
      console.warn(`Confirmation window expired for ${params.signature}, but the transaction was found on-chain.`);
      return landedReceipt;
    }

    if (params.jitoClient && params.jitoBundleId) {
      await logJitoBundleDiagnostics(params.jitoClient, params.jitoBundleId);
    }

    throw confirmError;
  }

  return buildExecutionReceipt({
    connection: params.connection,
    signature: params.signature,
    walletAddress: params.walletAddress,
    quote: params.quote,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
  });
}

async function broadcastTransactionViaRpc(params: {
  connection: Connection;
  transaction: VersionedTransaction;
  lastValidBlockHeight?: number;
  walletAddress: string;
  quote: ExecutionQuoteSummary;
  inputMint: string;
  outputMint: string;
}): Promise<ExecutionReceipt> {
  const rawTx = params.transaction.serialize();
  const txid = await params.connection.sendRawTransaction(rawTx, { skipPreflight: true });
  console.log("🚀 Transaction sent via RPC! TXID:", txid);
  console.log("🔗 View on Solscan: https://solscan.io/tx/" + txid);

  return confirmSubmittedTransaction({
    connection: params.connection,
    signature: txid,
    recentBlockhash: params.transaction.message.recentBlockhash,
    walletAddress: params.walletAddress,
    quote: params.quote,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    ...(params.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: params.lastValidBlockHeight } : {}),
  });
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

async function executePreparedTransaction(params: {
  plan: TradePlan;
  mode: ExecutionMode;
  transaction: VersionedTransaction;
  quote: ExecutionQuoteSummary;
  inputMint: string;
  outputMint: string;
  walletAddress: string;
  lastValidBlockHeight?: number;
  priorityFeeLamports?: number;
  priorityFeeSol?: number;
  debug?: Record<string, unknown>;
}): Promise<ExecutionReceipt | undefined> {
  const connection = new Connection(process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const jitoClient = new JitoClient();
  const wallet = loadExecutionWallet();
  const tipLamports = resolveJitoTipLamports();
  const augmented = await augmentTransactionForJito({
    connection,
    jitoClient,
    transaction: params.transaction,
    wallet,
    ...(tipLamports !== undefined ? { tipLamports } : {}),
    addDontFrontProtection: true,
  });

  if (augmented.augmentationError) {
    console.warn(`[JITO] Inline tip/dontfront augmentation skipped for ${params.mode}: ${augmented.augmentationError}`);
  }

  if (!params.plan.dryRun) {
    console.warn("\n!!! BROADCASTING LIVE TRANSACTION !!!\n");

    try {
      let jitoSubmission:
        | Awaited<ReturnType<JitoClient["submitTransaction"]>>
        | null = null;

      try {
        jitoSubmission = await jitoClient.submitTransaction(augmented.serializedTransactionBase64, { bundleOnly: true });
        console.log(
          `[JITO] Private send accepted via ${jitoSubmission.endpoint}. Signature: ${jitoSubmission.signature}${jitoSubmission.bundleId ? ` | bundle ${jitoSubmission.bundleId}` : ""}${augmented.tipLamports ? ` | tip ${augmented.tipLamports}` : ""}${augmented.tipAccount ? ` -> ${augmented.tipAccount}` : ""}${augmented.dontFrontProtected ? " | dontfront" : ""}`,
        );
      } catch (jitoSubmitError) {
        console.warn(`[JITO] Private send fehlgeschlagen. Fallback auf oeffentlichen RPC-Broadcast: ${jitoSubmitError instanceof Error ? jitoSubmitError.message : String(jitoSubmitError)}`);
      }

      if (!jitoSubmission) {
        return await broadcastTransactionViaRpc({
          connection,
          transaction: augmented.transaction,
          walletAddress: params.walletAddress,
          quote: params.quote,
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          ...(params.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: params.lastValidBlockHeight } : {}),
        });
      }

      const receipt = await confirmSubmittedTransaction({
        connection,
        signature: jitoSubmission.signature,
        recentBlockhash: augmented.transaction.message.recentBlockhash,
        walletAddress: params.walletAddress,
        quote: params.quote,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        jitoClient,
        ...(params.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: params.lastValidBlockHeight } : {}),
        ...(jitoSubmission.bundleId ? { jitoBundleId: jitoSubmission.bundleId } : {}),
      });

      console.log(`🚀 ${params.mode} transaction sent via Jito! TXID:`, jitoSubmission.signature);
      console.log("🔗 View on Solscan: https://solscan.io/tx/" + jitoSubmission.signature);
      if (jitoSubmission.bundleId) {
        console.log(`[JITO] Bundle-ID: ${jitoSubmission.bundleId}`);
      }

      return receipt;
    } catch (error) {
      console.error("Broadcast failed:", error);
      throw error;
    }
  }

  const simulation = await connection.simulateTransaction(augmented.transaction, { sigVerify: false });
  const preparedJitoTransaction = jitoClient.prepareTransaction(augmented.serializedTransactionBase64, { bundleOnly: true });

  console.log(JSON.stringify({
    mode: params.mode,
    plan: params.plan,
    priorityFeeLamports: params.priorityFeeLamports,
    priorityFeeSol: params.priorityFeeSol,
    maxPriorityFeeSol: env.MAX_PRIORITY_FEE_SOL,
    quote: params.quote,
    simulation,
    preparedJitoTransaction,
    jitoAugmentation: {
      augmented: augmented.augmented,
      ...(augmented.tipLamports !== undefined ? { tipLamports: augmented.tipLamports } : {}),
      ...(augmented.tipAccount ? { tipAccount: augmented.tipAccount } : {}),
      dontFrontProtected: augmented.dontFrontProtected,
      ...(augmented.augmentationError ? { augmentationError: augmented.augmentationError } : {}),
    },
    ...(params.debug ?? {}),
  }, null, 2));
}

async function executeRaydium(plan: TradePlan, priorityFeeLamports?: number, priorityFeeSol?: number) {
  if (plan.executionMode !== "raydium-sdk") {
    throw new Error(`Plan ${plan.planId} is not marked for raydium-sdk execution.`);
  }

  const executionService = new RaydiumExecutionService();
  const preparedExecution = await executionService.prepareExecutionForPlan(plan, {
    ...(priorityFeeLamports !== undefined ? { priorityFeeLamports } : {}),
  });
  const transaction = VersionedTransaction.deserialize(Buffer.from(preparedExecution.serializedTransactionBase64, "base64"));

  return executePreparedTransaction({
    plan,
    mode: "raydium-sdk",
    transaction,
    quote: buildDirectQuoteSummary({
      amountInRaw: preparedExecution.quote.amountInRaw,
      amountOutRaw: preparedExecution.quote.amountOutRaw,
      minAmountOutRaw: preparedExecution.quote.minAmountOutRaw,
      slippageBps: plan.maxSlippageBps,
    }),
    inputMint: preparedExecution.quote.inputMint,
    outputMint: preparedExecution.quote.outputMint,
    walletAddress: preparedExecution.ownerPublicKey,
    lastValidBlockHeight: preparedExecution.lastValidBlockHeight,
    ...(priorityFeeLamports !== undefined ? { priorityFeeLamports } : {}),
    ...(priorityFeeSol !== undefined ? { priorityFeeSol } : {}),
    debug: { preparedExecution },
  });
}

async function executePumpAmm(plan: TradePlan, priorityFeeLamports?: number, priorityFeeSol?: number) {
  if (plan.executionMode !== "pumpfun-amm") {
    throw new Error(`Plan ${plan.planId} is not marked for pumpfun-amm execution.`);
  }

  const executionService = new PumpAmmExecutionService();
  const preparedExecution = await executionService.prepareExecutionForPlan(plan, {
    ...(priorityFeeLamports !== undefined ? { priorityFeeLamports } : {}),
  });
  const transaction = VersionedTransaction.deserialize(Buffer.from(preparedExecution.serializedTransactionBase64, "base64"));

  return executePreparedTransaction({
    plan,
    mode: "pumpfun-amm",
    transaction,
    quote: buildDirectQuoteSummary({
      amountInRaw: preparedExecution.quote.amountInRaw,
      amountOutRaw: preparedExecution.quote.amountOutRaw,
      minAmountOutRaw: preparedExecution.quote.minAmountOutRaw,
      slippageBps: plan.maxSlippageBps,
    }),
    inputMint: preparedExecution.quote.inputMint,
    outputMint: preparedExecution.quote.outputMint,
    walletAddress: preparedExecution.ownerPublicKey,
    lastValidBlockHeight: preparedExecution.lastValidBlockHeight,
    ...(priorityFeeLamports !== undefined ? { priorityFeeLamports } : {}),
    ...(priorityFeeSol !== undefined ? { priorityFeeSol } : {}),
    debug: { preparedExecution },
  });
}

export async function executeJupiter(
  plan: TradePlan,
  precomputedPriority?: { priorityFeeLamports?: number; priorityFeeSol?: number },
): Promise<ExecutionReceipt | undefined> {
  if (plan.executionMode !== "jupiter") {
    throw new Error(`Plan ${plan.planId} is not marked for jupiter execution.`);
  }

  const wallet = loadExecutionWallet();
  console.log("Loaded execution wallet public key:", wallet.publicKey.toBase58());

  const jupiter = new JupiterClient();
  const priorityFeeLamports = precomputedPriority?.priorityFeeLamports
    ?? await new HeliusClient().getPriorityFeeEstimate([plan.tokenAddress]);
  const priorityFeeSol = precomputedPriority?.priorityFeeSol
    ?? (priorityFeeLamports !== undefined ? lamportsToSol(priorityFeeLamports) : undefined);

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
  return executePreparedTransaction({
    plan,
    mode: "jupiter",
    transaction,
    quote: toExecutionQuoteSummary(quote),
    inputMint: quoteInputMint,
    outputMint: quoteOutputMint,
    walletAddress: wallet.publicKey.toBase58(),
    ...(swap.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: swap.lastValidBlockHeight } : {}),
    ...(priorityFeeLamports !== undefined ? { priorityFeeLamports } : {}),
    ...(priorityFeeSol !== undefined ? { priorityFeeSol } : {}),
  });
}

export async function executeTradePlan(plan: TradePlan): Promise<ExecutionReceipt | undefined> {
  const helius = new HeliusClient();
  const priorityFeeLamports = await helius.getPriorityFeeEstimate([plan.tokenAddress]);
  const priorityFeeSol = priorityFeeLamports !== undefined ? lamportsToSol(priorityFeeLamports) : undefined;

  if (priorityFeeSol !== undefined && priorityFeeSol > env.MAX_PRIORITY_FEE_SOL) {
    throw new Error(
      `Trade aborted: Priority fee ${priorityFeeSol} exceeds safety limit ${env.MAX_PRIORITY_FEE_SOL}`,
    );
  }

  switch (plan.executionMode) {
    case "pumpfun-amm":
      return executePumpAmm(plan, priorityFeeLamports, priorityFeeSol);
    case "raydium-sdk":
      return executeRaydium(plan, priorityFeeLamports, priorityFeeSol);
    case "jupiter":
    default:
      return executeJupiter(plan, {
        ...(priorityFeeLamports !== undefined ? { priorityFeeLamports } : {}),
        ...(priorityFeeSol !== undefined ? { priorityFeeSol } : {}),
      });
  }
}

async function main() {
  const planInput = process.argv[2];

  if (!planInput) {
    console.error("Usage: npm run trade:execute -- <PLAN_ID|./data/plans/PLAN-123.json>");
    process.exit(1);
  }

  const plan = await loadPlan(planInput);

  await executeTradePlan(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof MissingConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(2);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Trade execution failed: ${message}`);
    process.exit(1);
  });
}
