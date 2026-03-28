import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HeliusClient } from "../clients/helius.js";

export interface RaydiumSdkTokenAccount {
  pubkey: PublicKey;
  accountInfo: {
    mint: PublicKey;
    amount: BN;
  };
}

export async function getWalletTokenAccounts(heliusClient: HeliusClient, owner: PublicKey): Promise<RaydiumSdkTokenAccount[]> {
  const rpcUrl = heliusClient.getRpcUrl();
  const body = {
    jsonrpc: "2.0",
    id: `wallet-token-accounts-${owner.toBase58()}`,
    method: "getTokenAccountsByOwner",
    params: [
      owner.toBase58(),
      { programId: TOKEN_PROGRAM_ID.toBase58() },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ],
  };

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Wallet token account fetch failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    error?: { code: number; message: string };
    result?: {
      value?: Array<{
        pubkey: string;
        account?: {
          data?: {
            parsed?: {
              info?: {
                mint?: string;
                tokenAmount?: { amount?: string };
              };
            };
          };
        };
      }>;
    };
  };

  if (payload.error) {
    throw new Error(`Wallet token account RPC error ${payload.error.code}: ${payload.error.message}`);
  }

  return (payload.result?.value ?? []).flatMap((entry) => {
    const mint = entry.account?.data?.parsed?.info?.mint;
    const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount;

    if (!mint || amount === undefined) {
      return [];
    }

    return [{
      pubkey: new PublicKey(entry.pubkey),
      accountInfo: {
        mint: new PublicKey(mint),
        amount: new BN(amount),
      },
    }];
  });
}

export function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
}

export function getWrappedSolMint(): PublicKey {
  return NATIVE_MINT;
}
