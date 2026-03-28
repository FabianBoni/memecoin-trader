import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./config/env.js";

function decodePrivateKey(raw: string): Uint8Array {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }

  return bs58.decode(trimmed);
}

export function loadExecutionWallet(): Keypair {
  const privateKey = env.SOLANA_PRIVATE_KEY?.trim() ?? env.SOLANA_WALLET_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("Missing SOLANA_PRIVATE_KEY (or SOLANA_WALLET_PRIVATE_KEY) in environment.");
  }

  return Keypair.fromSecretKey(decodePrivateKey(privateKey));
}
