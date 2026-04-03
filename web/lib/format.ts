export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleString("de-DE");
}

export function formatUsd(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "n/a";
  }

  const parsed = Number(value);
  if (parsed >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(parsed);
  }

  if (parsed >= 1) {
    return `$${parsed.toFixed(4)}`;
  }

  return `$${parsed.toExponential(4)}`;
}

export function formatSolPrice(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "n/a";
  }

  return `${Number(value).toExponential(4)} SOL`;
}

export function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }

  const parsed = Number(value);
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)}%`;
}

export function formatFractionPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }

  return `${(Number(value) * 100).toFixed(1)}%`;
}

export function formatSignedNumber(value: number | null | undefined, digits = 4): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }

  const parsed = Number(value);
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(digits)}`;
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
}

export function formatCount(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value));
}

export function formatEntrySourceLabel(value: string | null | undefined): string {
  switch (value) {
    case "market-snapshot":
      return "Jupiter";
    case "dexscreener-snapshot":
      return "Dexscreener";
    case "wallet-receipt":
      return "Wallet receipt";
    case "wallet-receipt-sol-only":
      return "SOL-only receipt";
    case "legacy":
      return "Legacy";
    default:
      return value && value.length > 0 ? value : "unknown";
  }
}

export function shortenAddress(value: string, start = 8, end = 4): string {
  return value.length <= start + end ? value : `${value.slice(0, start)}...${value.slice(-end)}`;
}