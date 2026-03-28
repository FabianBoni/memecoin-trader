import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { sendTelegram } from "./telegram-notifier.js";

const WHALE_FILE = './src/data/whales.json';
const RPC_URL = process.env.HELIUS_RPC_URL || "";

// Hilfsfunktion für Pausen
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scout() {
  console.log("🔎 [SCOUT] Starte Blockchain-Suche (Anti-Spam Modus)...");
  try {
    const connection = new Connection(RPC_URL);
    
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
    const tokens: any = await res.json();
    
    if (!tokens || tokens.length === 0) return;

    const topToken = tokens[0]; 
    const mintAddress = topToken.tokenAddress;
    console.log(`🔥 Hype-Token erkannt: ${mintAddress}`);

    const mintPubKey = new PublicKey(mintAddress);
    // Wir holen nur die letzten 5 Käufer, das reicht für die Elite!
    const signatures = await connection.getSignaturesForAddress(mintPubKey, { limit: 5 });
    
    const currentWhales: string[] = JSON.parse(fs.readFileSync(WHALE_FILE, 'utf-8'));
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
           await sendTelegram(`🎯 <b>NEUER WAL GEFUNDEN!</b>\nToken: <code>${mintAddress}</code>\nWallet: <code>${walletAddress}</code>`);
           
           if (addedCount >= 2) break;
        }
        
        // 1 Sekunde Pause, damit Helius uns nicht blockt!
        await sleep(1000);

      } catch (txError: any) {
         console.log(`Überspringe TX wegen Fehler: ${txError.message}`);
      }
    }

    if (addedCount > 0) {
        fs.writeFileSync(WHALE_FILE, JSON.stringify(currentWhales, null, 2));
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
