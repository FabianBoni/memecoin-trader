import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";
import { PublicKey } from "@solana/web3.js";
import type { RawAccountInfo } from "../types/token.js";

export const RAYDIUM_AMM_V4_PROGRAM_IDS = new Set<string>([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
]);

export interface DecodedRaydiumPoolState {
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  marketId: string;
  baseVault: string;
  quoteVault: string;
  openOrders: string;
}

function toPublicKeyString(value: unknown): string {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }

  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }

  throw new Error("Unable to convert Raydium layout field to public key string.");
}

export function isRaydiumAmmV4Owner(owner: string): boolean {
  return RAYDIUM_AMM_V4_PROGRAM_IDS.has(owner);
}

export function decodeRaydiumPoolState(account: RawAccountInfo): DecodedRaydiumPoolState {
  const raw = Buffer.from(account.dataBase64, "base64");

  if (raw.length < LIQUIDITY_STATE_LAYOUT_V4.span) {
    throw new Error(`Account data too short for Raydium v4 layout: ${raw.length}`);
  }

  const decoded = LIQUIDITY_STATE_LAYOUT_V4.decode(raw);

  return {
    baseMint: toPublicKeyString(decoded.baseMint),
    quoteMint: toPublicKeyString(decoded.quoteMint),
    lpMint: toPublicKeyString(decoded.lpMint),
    marketId: toPublicKeyString(decoded.marketId),
    baseVault: toPublicKeyString(decoded.baseVault),
    quoteVault: toPublicKeyString(decoded.quoteVault),
    openOrders: toPublicKeyString(decoded.openOrders),
  };
}
