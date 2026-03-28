import type { OpenPosition, TradePlan } from "../types/trade.js";
import { loadJsonFile, saveJsonFile } from "./json-store.js";

const PLANS_FILE = "trade-plans.json";
const POSITIONS_FILE = "positions.json";

export async function loadTradePlans(): Promise<TradePlan[]> {
  return loadJsonFile<TradePlan[]>(PLANS_FILE, []);
}

export async function saveTradePlan(plan: TradePlan): Promise<void> {
  const plans = await loadTradePlans();
  plans.push(plan);
  await saveJsonFile(PLANS_FILE, plans);
}

export async function loadOpenPositions(): Promise<OpenPosition[]> {
  return loadJsonFile<OpenPosition[]>(POSITIONS_FILE, []);
}

export async function saveOpenPositions(positions: OpenPosition[]): Promise<void> {
  await saveJsonFile(POSITIONS_FILE, positions);
}
