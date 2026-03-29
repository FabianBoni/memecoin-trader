import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { createLogger, type LogLevel } from "../utils/logger.js";

loadDotEnv();

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim().length === 0 ? undefined : value;
}

function optionalString() {
  return z.preprocess(emptyStringToUndefined, z.string().optional());
}

function optionalUrl() {
  return z.preprocess(emptyStringToUndefined, z.string().url().optional());
}

function optionalNonNegativeInt() {
  return z.preprocess(emptyStringToUndefined, z.coerce.number().int().nonnegative().optional());
}

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
  HELIUS_API_KEY: optionalString(),
  HELIUS_RPC_URL: optionalUrl(),
  BIRDEYE_API_KEY: optionalString(),
  SOLANA_RPC_URL: optionalUrl(),
  FALLBACK_MAINNET_RPC_URL: optionalUrl(),
  DEXSCREENER_BASE_URL: z.string().url().default("https://api.dexscreener.com/latest"),
  SOLANA_WALLET_PUBLIC_KEY: optionalString(),
  SOLANA_WALLET_PRIVATE_KEY: optionalString(),
  SOLANA_PRIVATE_KEY: optionalString(),
  RAYDIUM_AMM_PROGRAM_ID: optionalString(),
  PUMPFUN_PROGRAM_ID: optionalString(),
  PUMPFUN_AMM_PROGRAM_ID: optionalString(),
  LP_LOCKER_ADDRESSES: optionalString(),
  JITO_BLOCK_ENGINE_URL: optionalUrl(),
  JITO_AUTH_KEY: optionalString(),
  JITO_BUNDLE_TIP_LAMPORTS: optionalNonNegativeInt(),
  MAX_PRIORITY_FEE_SOL: z.coerce.number().nonnegative().default(0.01),
  MAX_JUPITER_BUY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(250),
  MAX_JUPITER_VOLATILE_BUY_SLIPPAGE_BPS: z.coerce.number().int().positive().default(500),
  MAX_JUPITER_SELL_SLIPPAGE_BPS: z.coerce.number().int().positive().default(500),
  MAX_JUPITER_PRICE_IMPACT_PCT: z.coerce.number().nonnegative().default(15),
  MAX_JUPITER_ROUTE_HOPS: z.coerce.number().int().positive().default(2),
  AUTO_BUY_AMOUNT_SOL: z.coerce.number().positive().default(0.3),
  MIN_LIVE_TRADE_SIZE_SOL: z.coerce.number().positive().default(0.03),
  RISK_PER_TRADE_PCT: z.coerce.number().positive().max(10).default(1.5),
  MAX_CAPITAL_AT_RISK_PCT: z.coerce.number().positive().max(100).default(6),
  ESTIMATED_ROUND_TRIP_COST_BPS: z.coerce.number().int().nonnegative().default(350),
  DEFAULT_MAX_POSITION_SOL: z.coerce.number().positive().default(0.3),
  DEFAULT_MAX_OPEN_EXPOSURE_SOL: z.coerce.number().positive().default(0.5),
  DEFAULT_MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(250),
  DEFAULT_STOP_LOSS_PCT: z.coerce.number().positive().default(30),
  DEFAULT_TAKE_PROFIT_PCT: z.coerce.number().positive().default(100),
  DEFAULT_TAKE_PROFIT_SELL_FRACTION: z.coerce.number().positive().max(1).default(0.5),
  RUNNER_STOP_FLOOR_PCT: z.coerce.number().nonnegative().default(10),
  TRAILING_ARM_PCT: z.coerce.number().nonnegative().default(25),
  TRAILING_DISTANCE_PCT: z.coerce.number().nonnegative().default(15),
  PAPER_PROMOTION_MIN_TRADES: z.coerce.number().int().positive().default(8),
  PAPER_PROMOTION_MIN_WIN_RATE_PCT: z.coerce.number().min(0).max(100).default(60),
  PAPER_PROMOTION_MIN_AVG_PNL_PCT: z.coerce.number().default(5),
  PAPER_PROMOTION_MIN_MEDIAN_PNL_PCT: z.coerce.number().default(2),
  LIVE_ELIMINATION_MIN_TRADES: z.coerce.number().int().positive().default(5),
  LIVE_ELIMINATION_MAX_LOSS_STREAK: z.coerce.number().int().positive().default(4),
  LIVE_ELIMINATION_MAX_AVG_PNL_PCT: z.coerce.number().default(-8),
  MIN_ENTRY_LIQUIDITY_USD: z.coerce.number().nonnegative().default(25000),
  MIN_WHALE_BUY_SIZE_SOL: z.coerce.number().nonnegative().default(0.5),
  MAX_ENTRY_PRICE_EXTENSION_PCT: z.coerce.number().nonnegative().default(12),
  MIN_EXPECTED_NET_PROFIT_PCT: z.coerce.number().nonnegative().default(18),
  MIN_REWARD_RISK_RATIO: z.coerce.number().positive().default(1.35),
  WHALE_SELL_TRIM_IGNORE_FRACTION_PCT: z.coerce.number().min(0).max(100).default(25),
  WHALE_PANIC_SELL_MIN_FRACTION_PCT: z.coerce.number().min(0).max(100).default(70),
  SCOUT_BOOST_SCAN_LIMIT: z.coerce.number().int().positive().default(12),
  SCOUT_BOOST_TOKEN_LIMIT: z.coerce.number().int().positive().default(5),
  SCOUT_MARKET_TOKEN_LIMIT: z.coerce.number().int().positive().default(12),
  SCOUT_SEED_CHECK_LIMIT: z.coerce.number().int().positive().default(10),
  SCOUT_MIN_SEED_VOLUME_USD: z.coerce.number().nonnegative().default(100000),
  SCOUT_MIN_SEED_LIQUIDITY_USD: z.coerce.number().nonnegative().default(25000),
  SCOUT_MIN_SEED_TX_COUNT: z.coerce.number().int().nonnegative().default(100),
  SCOUT_MIN_SEED_AVG_TRADE_USD: z.coerce.number().nonnegative().default(125),
  SCOUT_MIN_SEED_TRADER_VOLUME_USD: z.coerce.number().nonnegative().default(1000),
  SCOUT_PARSED_TX_BATCH_SIZE: z.coerce.number().int().positive().default(12),
  SCOUT_TOKEN_SIGNATURE_BATCH_LIMIT: z.coerce.number().int().positive().default(50),
  SCOUT_TOKEN_SIGNATURE_LIMIT: z.coerce.number().int().positive().default(8),
  SCOUT_TOKEN_SIGNATURE_SCAN_CAP: z.coerce.number().int().positive().default(150),
  SCOUT_WHALE_SIGNATURE_LIMIT: z.coerce.number().int().positive().default(20),
  SCOUT_WHALE_DEEP_SIGNATURE_LIMIT: z.coerce.number().int().positive().default(120),
  SCOUT_WHALE_EXTENDED_SIGNATURE_LIMIT: z.coerce.number().int().positive().default(300),
  SCOUT_WHALE_LOOKBACK_HOURS: z.coerce.number().int().positive().default(24),
  SCOUT_DEEP_SCAN_TRIGGER_VOLUME_USD: z.coerce.number().nonnegative().default(2500),
  SCOUT_MIN_WHALE_VOLUME_USD: z.coerce.number().nonnegative().default(25000),
  SCOUT_MIN_WHALE_TX_COUNT: z.coerce.number().int().positive().default(6),
  SCOUT_MIN_WHALE_DISTINCT_TOKENS: z.coerce.number().int().positive().default(2),
  SCOUT_RPC_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(500),
  SCOUT_RATE_LIMIT_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(4000),
  SCOUT_REJECT_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(180),
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

export function getReadOnlyRpcUrl(primaryRpcUrl?: string): string {
  const normalizedPrimary = primaryRpcUrl ? assertMainnetish(primaryRpcUrl, "PRIMARY_RPC_URL") : undefined;
  const candidates: Array<{ key: string; value: string | undefined }> = [
    { key: "FALLBACK_MAINNET_RPC_URL", value: env.FALLBACK_MAINNET_RPC_URL },
    { key: "SOLANA_RPC_URL", value: env.SOLANA_RPC_URL },
    { key: "HELIUS_RPC_URL", value: env.HELIUS_RPC_URL },
    {
      key: "HELIUS_API_KEY",
      value: env.HELIUS_API_KEY && env.HELIUS_API_KEY.trim().length > 0
        ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
        : undefined,
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.value || candidate.value.trim().length === 0) {
      continue;
    }

    const normalizedCandidate = assertMainnetish(candidate.value, candidate.key);
    if (!normalizedPrimary || normalizedCandidate !== normalizedPrimary) {
      return normalizedCandidate;
    }
  }

  return normalizedPrimary ?? getHeliusRpcUrl();
}
