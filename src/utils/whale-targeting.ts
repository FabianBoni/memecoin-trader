const NON_TARGET_WHALE_MINT_LABELS = new Map<string, string>([
  ['So11111111111111111111111111111111111111112', 'SOL'],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
  ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP'],
  ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'RAY'],
  ['orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', 'ORCA'],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
  ['HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'PYTH'],
]);

const NON_TARGET_WHALE_MINTS = new Set<string>(NON_TARGET_WHALE_MINT_LABELS.keys());

export function isNonTargetWhaleMint(mint?: string | null): boolean {
  return typeof mint === 'string'
    && mint.trim().length > 0
    && NON_TARGET_WHALE_MINTS.has(mint.trim());
}

export function describeNonTargetWhaleMint(mint?: string | null): string {
  if (typeof mint !== 'string' || mint.trim().length === 0) {
    return 'unknown';
  }

  const normalizedMint = mint.trim();
  return NON_TARGET_WHALE_MINT_LABELS.get(normalizedMint) ?? normalizedMint;
}

export function filterMeaningfulWhaleTargetMints(mints: Iterable<string>): string[] {
  const meaningfulMints = new Set<string>();

  for (const mint of mints) {
    const normalizedMint = mint.trim();
    if (normalizedMint.length === 0 || isNonTargetWhaleMint(normalizedMint)) {
      continue;
    }

    meaningfulMints.add(normalizedMint);
  }

  return [...meaningfulMints];
}