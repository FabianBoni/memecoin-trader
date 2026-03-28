import { MissingConfigError, env, logger } from "../config/env.js";
import { TokenScreenService } from "../services/token-screen.js";

async function main() {
  const tokenAddress = process.argv[2];

  if (!tokenAddress) {
    console.error("Usage: npm run screen:token -- <TOKEN_MINT_ADDRESS>");
    process.exit(1);
  }

  if (env.DRY_RUN) {
    logger.info("Running in DRY_RUN mode. No live trade execution is possible.");
  }

  const service = new TokenScreenService();
  const result = await service.screenToken(tokenAddress);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof MissingConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(2);
  }

  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Token screen failed: ${message}`);
  process.exit(1);
});
