export function basisPointsToPercent(bps: number): number {
  return bps / 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
