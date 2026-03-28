import { loadOpenPositions } from "../storage/trades.js";

export interface ExposureSummary {
  openPositions: number;
  currentOpenExposureSol: number;
  remainingExposureCapacitySol: number;
}

export async function getExposureSummary(maxOpenExposureSol: number): Promise<ExposureSummary> {
  const positions = await loadOpenPositions();
  const open = positions.filter((position) => position.status === "open");
  const currentOpenExposureSol = open.reduce((sum, position) => sum + position.sizeSol, 0);
  const remainingExposureCapacitySol = Math.max(0, maxOpenExposureSol - currentOpenExposureSol);

  return {
    openPositions: open.length,
    currentOpenExposureSol,
    remainingExposureCapacitySol,
  };
}
