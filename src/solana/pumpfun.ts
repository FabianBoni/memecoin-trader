import { PublicKey } from "@solana/web3.js";
import type { RawAccountInfo } from "../types/token.js";

export interface PumpFunBondingCurveState {
  complete: boolean;
  virtualTokenReserves: string;
  virtualSolReserves: string;
  realTokenReserves: string;
  realSolReserves: string;
  tokenTotalSupply: string;
  creator: string;
}

const PUMP_BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function readPublicKey(buffer: Buffer, offset: number): string {
  return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
}

export function getPumpProgramId(): string {
  return "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
}

export function getPumpAmmProgramId(): string {
  return "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
}

function findProgramAddressSync(seeds: Buffer[], programId: string): string {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();
}

export function derivePumpBondingCurveAddresses(mintAddress: string): string[] {
  const mint = new PublicKey(mintAddress);
  return [
    findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], getPumpProgramId()),
    findProgramAddressSync([Buffer.from("bonding-curve-v2"), mint.toBuffer()], getPumpProgramId()),
  ];
}

export function deriveCanonicalPumpPoolAddress(mintAddress: string): string {
  const mint = new PublicKey(mintAddress);
  const poolAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    new PublicKey(getPumpAmmProgramId()),
  )[0];

  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from([0]), poolAuthority.toBuffer(), mint.toBuffer(), new PublicKey("So11111111111111111111111111111111111111112").toBuffer()],
    new PublicKey(getPumpAmmProgramId()),
  )[0].toBase58();
}

export function decodePumpBondingCurve(account: RawAccountInfo): PumpFunBondingCurveState {
  const raw = Buffer.from(account.dataBase64, "base64");

  if (raw.length < 89) {
    throw new Error(`Pump bonding curve account too short: ${raw.length}`);
  }

  const discriminator = raw.subarray(0, 8);
  if (!discriminator.equals(PUMP_BONDING_CURVE_DISCRIMINATOR)) {
    throw new Error("Account discriminator does not match Pump bonding curve layout.");
  }

  return {
    virtualTokenReserves: readU64LE(raw, 8).toString(),
    virtualSolReserves: readU64LE(raw, 16).toString(),
    realTokenReserves: readU64LE(raw, 24).toString(),
    realSolReserves: readU64LE(raw, 32).toString(),
    tokenTotalSupply: readU64LE(raw, 40).toString(),
    complete: raw[48] === 1,
    creator: readPublicKey(raw, 49),
  };
}
