import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { sendTelegram } from "./telegram-notifier.js";
import { readJsonFileSync, writeJsonFileSync } from "../storage/json-file-sync.js";

const WHALE_FILE = './src/data/whales.json';
const RPC_URL = process.env.HELIUS_RPC_URL || "";

// Hilfsfunktion für Pausen
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isLikelySolanaMintAddress(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length < 32 || trimmed.length > 44) {
    return false;
  }

  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

async function scout() {
  console.log("🔎 [SCOUT] Starte Blockchain-Suche (Anti-Spam Modus)...");
  try {
    const connection = new Connection(RPC_URL);
    
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
    const tokens: any = await res.json();
    
    if (!tokens || tokens.length === 0) return;

    const topToken = tokens[0]; 
    const mintAddress = topToken.tokenAddress;

    if (topToken.chainId !== 'solana' || !isLikelySolanaMintAddress(mintAddress)) {
      console.log(`⏭ [SCOUT] Ueberspringe Nicht-Solana oder ungueltigen Token: ${String(mintAddress)}`);
      return;
    }

    console.log(`🔥 Hype-Token erkannt: ${mintAddress}`);

    const mintPubKey = new PublicKey(mintAddress);
    // Wir holen nur die letzten 5 Käufer, das reicht für die Elite!
    const signatures = await connection.getSignaturesForAddress(mintPubKey, { limit: 5 });
    
    const currentWhales = readJsonFileSync<string[]>(WHALE_FILE, []);
    let addedCount = 0;

    // Wir rufen die Transaktionen einzeln ab, mit Pause dazwischen!
    for (const sigObj of signatures) {
      try {
        const tx = await connection.getParsedTransaction(sigObj.signature, { 
            maxSupportedTransactionVersion: 0 
        });

        if (!tx || !tx.transaction) continue;
        
        const signer = tx.transaction.message.accountKeys.find((acc: any) => acc.signer);
        if (!signer) continue;
        
        const walletAddress = signer.pubkey.toBase58();

        if (!currentWhales.includes(walletAddress)) {
           currentWhales.push(walletAddress);
           addedCount++;
           
           console.log(`🎯 [SCOUT] Neuer Trader entdeckt: ${walletAddress}`);
           await sendTelegram(`🎯 <b>NEUER WAL GEFUNDEN!</b>\nToken: <code>${mintAddress}</code>\nWallet: <code>${walletAddress}</code>`, {
             dedupeKey: `scout-new-whale:${mintAddress}:${walletAddress}`,
             cooldownMs: 24 * 60 * 60 * 1000,
           });
           
           if (addedCount >= 2) break;
        }
        
        // 1 Sekunde Pause, damit Helius uns nicht blockt!
        await sleep(1000);

      } catch (txError: any) {
         console.log(`Überspringe TX wegen Fehler: ${txError.message}`);
      }
    }

    if (addedCount > 0) {
        writeJsonFileSync(WHALE_FILE, currentWhales);
        console.log(`✅ [SCOUT] ${addedCount} neue Wale hinzugefügt!`);
    } else {
        console.log(`⏳ [SCOUT] Keine neuen Wale hinzugefügt.`);
    }

  } catch (e: any) {
    console.error("❌ Scout Fehler:", e.message);
  }
}

setInterval(scout, 1000 * 60 * 60);
scout();
