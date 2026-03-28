import { PublicKey } from "@solana/web3.js";
import { getPumpAmmProgramId } from "./pumpfun.js";
import type { RawAccountInfo } from "../types/token.js";

export const PUMP_AMM_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

export interface PumpAmmPoolAccount {
  valid: boolean;
  discriminatorMatched: boolean;
  owner: string;
  address: string;
  lpMint?: string;
  baseMint?: string;
  quoteMint?: string;
}

export function hasPumpAmmPoolDiscriminator(account: RawAccountInfo): boolean {
  const raw = Buffer.from(account.dataBase64, "base64");
  if (raw.length < 8) return false;
  return raw.subarray(0, 8).equals(PUMP_AMM_POOL_DISCRIMINATOR);
}

export async function decodePumpAmmPool(address: string, account: RawAccountInfo): Promise<PumpAmmPoolAccount> {
  return {
    valid: true,
    discriminatorMatched: hasPumpAmmPoolDiscriminator(account),
    owner: account.owner,
    address: new PublicKey(address).toBase58(),
  };
}

export function isRecognizedPumpAmmPool(account: RawAccountInfo): boolean {
  return account.owner === getPumpAmmProgramId() && hasPumpAmmPoolDiscriminator(account);
}
