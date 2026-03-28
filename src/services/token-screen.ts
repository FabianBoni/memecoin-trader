import { HeliusClient } from "../clients/helius.js";
import { LiquidityScreenService } from "./liquidity-screen.js";
import type { TokenSecurityScreen, SplTokenMintAccountInfo } from "../types/token.js";

function isAuthorityRevoked(option?: number, authority?: string | null): boolean {
  if (option === 0) return true;
  if (authority === null) return true;
  if (authority === undefined) return false;
  return authority.trim().length === 0;
}

function buildAuthorityChecks(info: SplTokenMintAccountInfo) {
  return {
    mintAuthorityRevoked: isAuthorityRevoked(info.mintAuthorityOption, info.mintAuthority),
    freezeAuthorityRevoked: isAuthorityRevoked(info.freezeAuthorityOption, info.freezeAuthority),
  };
}

export class TokenScreenService {
  constructor(
    private readonly heliusClient = new HeliusClient(),
    private readonly liquidityScreenService = new LiquidityScreenService(),
  ) {}

  async screenToken(tokenAddress: string): Promise<TokenSecurityScreen> {
    const warnings: string[] = [];
    const reasons: string[] = [];

    const mintInfo = await this.heliusClient.getParsedTokenMintInfo(tokenAddress);
    const checks = buildAuthorityChecks(mintInfo);
    const liquidity = await this.liquidityScreenService.screenLiquidity(tokenAddress);

    if (!checks.mintAuthorityRevoked) {
      reasons.push("Mint Authority is still enabled.");
    }

    if (!checks.freezeAuthorityRevoked) {
      reasons.push("Freeze Authority is still enabled.");
    }

    warnings.push(...liquidity.warnings);
    reasons.push(...liquidity.reasons);

    return {
      tokenAddress,
      mintAuthorityRevoked: checks.mintAuthorityRevoked,
      freezeAuthorityRevoked: checks.freezeAuthorityRevoked,
      liquidityCheckPassed: liquidity.passed,
      liquidityCheckStatus: liquidity.status,
      passed: checks.mintAuthorityRevoked && checks.freezeAuthorityRevoked && liquidity.passed,
      warnings,
      reasons,
      source: {
        heliusRpcUrl: this.heliusClient.getRpcUrl(),
      },
      liquidity,
    };
  }
}
