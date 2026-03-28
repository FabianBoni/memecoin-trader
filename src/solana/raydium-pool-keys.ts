import BN from "bn.js";
import { MARKET_STATE_LAYOUT_V3, Market, LIQUIDITY_STATE_LAYOUT_V4, Liquidity, TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import { PublicKey } from "@solana/web3.js";
import { HeliusClient } from "../clients/helius.js";

export interface ResolvedRaydiumPoolKeys {
  id: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  lpDecimals: number;
  version: 4;
  programId: PublicKey;
  authority: PublicKey;
  openOrders: PublicKey;
  targetOrders: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  withdrawQueue: PublicKey;
  lpVault: PublicKey;
  marketVersion: 3;
  marketProgramId: PublicKey;
  marketId: PublicKey;
  marketAuthority: PublicKey;
  marketBaseVault: PublicKey;
  marketQuoteVault: PublicKey;
  marketBids: PublicKey;
  marketAsks: PublicKey;
  marketEventQueue: PublicKey;
  lookupTableAccount: PublicKey;
}

export interface ResolvedRaydiumPoolInfo {
  baseReserve: BN;
  quoteReserve: BN;
  baseDecimals: number;
  quoteDecimals: number;
  lpDecimals: number;
}

function toPublicKey(value: unknown): PublicKey {
  if (value instanceof PublicKey) return value;
  return new PublicKey(String(value));
}

function toNumberSafe(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    return Number(value.toString());
  }
  return Number(value);
}

function toBN(value: string | undefined): BN {
  return new BN(value ?? "0");
}

export async function resolveRaydiumPoolKeys(heliusClient: HeliusClient, poolAddress: string): Promise<{ poolKeys: ResolvedRaydiumPoolKeys; poolInfo: ResolvedRaydiumPoolInfo; }> {
  const rawPoolAccount = await heliusClient.getRawAccountInfo(poolAddress);
  const poolBuffer = Buffer.from(rawPoolAccount.dataBase64, "base64");
  const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(poolBuffer);

  const marketId = toPublicKey(poolState.marketId);
  const marketProgramId = toPublicKey(poolState.marketProgramId);
  const rawMarketAccount = await heliusClient.getRawAccountInfo(marketId.toBase58());
  const marketBuffer = Buffer.from(rawMarketAccount.dataBase64, "base64");
  const marketState = MARKET_STATE_LAYOUT_V3.decode(marketBuffer);

  const ammAuthority = Liquidity.getAssociatedAuthority({ programId: new PublicKey(rawPoolAccount.owner) }).publicKey;
  const marketAuthority = Market.getAssociatedAuthority({ programId: marketProgramId, marketId }).publicKey;

  const baseDecimals = toNumberSafe(poolState.baseDecimal);
  const quoteDecimals = toNumberSafe(poolState.quoteDecimal);
  const lpMintInfo = await heliusClient.getParsedTokenMintInfo(toPublicKey(poolState.lpMint).toBase58());
  const baseVaultInfo = await heliusClient.getParsedTokenAccountInfo(toPublicKey(poolState.baseVault).toBase58());
  const quoteVaultInfo = await heliusClient.getParsedTokenAccountInfo(toPublicKey(poolState.quoteVault).toBase58());

  const poolKeys: ResolvedRaydiumPoolKeys = {
    id: new PublicKey(poolAddress),
    baseMint: toPublicKey(poolState.baseMint),
    quoteMint: toPublicKey(poolState.quoteMint),
    lpMint: toPublicKey(poolState.lpMint),
    baseDecimals,
    quoteDecimals,
    lpDecimals: lpMintInfo.decimals ?? 9,
    version: 4,
    programId: new PublicKey(rawPoolAccount.owner),
    authority: ammAuthority,
    openOrders: toPublicKey(poolState.openOrders),
    targetOrders: toPublicKey(poolState.targetOrders),
    baseVault: toPublicKey(poolState.baseVault),
    quoteVault: toPublicKey(poolState.quoteVault),
    withdrawQueue: toPublicKey(poolState.withdrawQueue),
    lpVault: toPublicKey(poolState.lpVault),
    marketVersion: 3,
    marketProgramId,
    marketId,
    marketAuthority,
    marketBaseVault: toPublicKey(marketState.baseVault),
    marketQuoteVault: toPublicKey(marketState.quoteVault),
    marketBids: toPublicKey(marketState.bids),
    marketAsks: toPublicKey(marketState.asks),
    marketEventQueue: toPublicKey(marketState.eventQueue),
    lookupTableAccount: PublicKey.default,
  };

  const poolInfo: ResolvedRaydiumPoolInfo = {
    baseReserve: toBN(baseVaultInfo.tokenAmount?.amount),
    quoteReserve: toBN(quoteVaultInfo.tokenAmount?.amount),
    baseDecimals,
    quoteDecimals,
    lpDecimals: lpMintInfo.decimals ?? 9,
  };

  return { poolKeys, poolInfo };
}

export function getRaydiumTokenProgramId(): PublicKey {
  return TOKEN_PROGRAM_ID;
}
