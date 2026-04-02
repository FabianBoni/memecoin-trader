import { PublicKey } from "@solana/web3.js";
import type { RawAccountInfo } from "../types/token.js";

export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

const WHIRLPOOL_DISCRIMINATOR = Buffer.from([63, 149, 209, 12, 225, 128, 99, 9]);
const MIN_WHIRLPOOL_ACCOUNT_LENGTH = 269;

export interface DecodedOrcaWhirlpoolState {
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  tokenMintA: string;
  tokenVaultA: string;
  tokenMintB: string;
  tokenVaultB: string;
}

function readU128LE(raw: Buffer, offset: number): bigint {
  const low = raw.readBigUInt64LE(offset);
  const high = raw.readBigUInt64LE(offset + 8);
  return low + (high << 64n);
}

function readPublicKey(raw: Buffer, offset: number): string {
  return new PublicKey(raw.subarray(offset, offset + 32)).toBase58();
}

export function isOrcaWhirlpoolOwner(owner: string): boolean {
  return owner === ORCA_WHIRLPOOL_PROGRAM_ID;
}

export function isRecognizedOrcaWhirlpool(account: RawAccountInfo): boolean {
  const raw = Buffer.from(account.dataBase64, "base64");
  return isOrcaWhirlpoolOwner(account.owner)
    && raw.length >= 8
    && raw.subarray(0, 8).equals(WHIRLPOOL_DISCRIMINATOR);
}

export function decodeOrcaWhirlpoolState(account: RawAccountInfo): DecodedOrcaWhirlpoolState {
  const raw = Buffer.from(account.dataBase64, "base64");

  if (raw.length < MIN_WHIRLPOOL_ACCOUNT_LENGTH) {
    throw new Error(`Account data too short for Orca Whirlpool layout: ${raw.length}`);
  }

  if (!raw.subarray(0, 8).equals(WHIRLPOOL_DISCRIMINATOR)) {
    throw new Error("Account discriminator did not match Orca Whirlpool.");
  }

  return {
    tickSpacing: raw.readUInt16LE(41),
    feeRate: raw.readUInt16LE(45),
    liquidity: readU128LE(raw, 49),
    sqrtPrice: readU128LE(raw, 65),
    tickCurrentIndex: raw.readInt32LE(81),
    tokenMintA: readPublicKey(raw, 101),
    tokenVaultA: readPublicKey(raw, 133),
    tokenMintB: readPublicKey(raw, 181),
    tokenVaultB: readPublicKey(raw, 213),
  };
}