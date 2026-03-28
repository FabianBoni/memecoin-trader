import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { createLogger, type LogLevel } from "../utils/logger.js";

loadDotEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((value) => value === undefined ? true : value.toLowerCase() === "true"),
  RPC_DEBUG_USE_CURL: z
    .string()
    .optional()
    .transform((value) => value === undefined ? false : value.toLowerCase() === "true"),
  STORE_PATH: z.string().default("./data"),
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().url().optional(),
  BIRDEYE_API_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  FALLBACK_MAINNET_RPC_URL: z.string().url().optional(),
  DEXSCREENER_BASE_URL: z.string().url().default("https://api.dexscreener.com/latest"),
  SOLANA_WALLET_PUBLIC_KEY: z.string().optional(),
  SOLANA_WALLET_PRIVATE_KEY: z.string().optional(),
  SOLANA_PRIVATE_KEY: z.string().optional(),
  RAYDIUM_AMM_PROGRAM_ID: z.string().optional(),
  PUMPFUN_PROGRAM_ID: z.string().optional(),
  PUMPFUN_AMM_PROGRAM_ID: z.string().optional(),
  LP_LOCKER_ADDRESSES: z.string().optional(),
  JITO_BLOCK_ENGINE_URL: z.string().url().optional(),
  JITO_AUTH_KEY: z.string().optional(),
  JITO_BUNDLE_TIP_LAMPORTS: z.coerce.number().int().nonnegative().optional(),
  MAX_PRIORITY_FEE_SOL: z.coerce.number().nonnegative().default(0.01),
  AUTO_BUY_AMOUNT_SOL: z.coerce.number().positive().default(0.1),
  DEFAULT_MAX_POSITION_SOL: z.coerce.number().positive().default(0.3),
  DEFAULT_MAX_OPEN_EXPOSURE_SOL: z.coerce.number().positive().default(0.5),
  DEFAULT_MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(1000),
  DEFAULT_STOP_LOSS_PCT: z.coerce.number().positive().default(30),
  DEFAULT_TAKE_PROFIT_PCT: z.coerce.number().positive().default(100),
  DEFAULT_TAKE_PROFIT_SELL_FRACTION: z.coerce.number().positive().max(1).default(0.5),
  REQUIRE_EXPLICIT_GO: z
    .string()
    .optional()
    .transform((value) => value === undefined ? true : value.toLowerCase() === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Environment validation failed", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const logger = createLogger(env.LOG_LEVEL as LogLevel);

export class MissingConfigError extends Error {
  constructor(key: string, message?: string) {
    super(message ?? `Missing required configuration: ${key}`);
    this.name = "MissingConfigError";
  }
}

export function getRequiredEnv(key: keyof typeof env): string {
  const value = env[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissingConfigError(String(key));
  }

  return value;
}

function assertMainnetish(url: string, keyName: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("devnet") || lower.includes("testnet")) {
    throw new MissingConfigError(
      keyName,
      `${keyName} points to a non-mainnet Solana cluster. Use a mainnet-beta / mainnet Helius RPC URL.`,
    );
  }
  return url;
}

export function getHeliusRpcUrl(): string {
  let rpcUrl: string | undefined;

  if (env.HELIUS_RPC_URL && env.HELIUS_RPC_URL.trim().length > 0) {
    rpcUrl = assertMainnetish(env.HELIUS_RPC_URL, "HELIUS_RPC_URL");
  } else if (env.SOLANA_RPC_URL && env.SOLANA_RPC_URL.trim().length > 0) {
    rpcUrl = assertMainnetish(env.SOLANA_RPC_URL, "SOLANA_RPC_URL");
  } else if (env.HELIUS_API_KEY && env.HELIUS_API_KEY.trim().length > 0) {
    rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  }

  if (!rpcUrl) {
    throw new MissingConfigError(
      "HELIUS_API_KEY",
      "Missing Solana RPC configuration. Set HELIUS_RPC_URL, SOLANA_RPC_URL, or HELIUS_API_KEY.",
    );
  }

  return rpcUrl;
}
