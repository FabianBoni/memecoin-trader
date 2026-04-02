import type { OpenPosition, TradePlan } from "../types/trade.js";
import { getDatabase, isDatabaseEnabled } from "./database.js";
import { loadJsonFile, saveJsonFile } from "./json-store.js";

const PLANS_FILE = "trade-plans.json";
const POSITIONS_FILE = "positions.json";
const ACTIVE_TRADES_FILE = "active-trades.json";

type TradePlanRow = {
  payload_json: string;
};

type ActiveTradeSnapshot = Record<string, Record<string, unknown>>;

function normalizeOpenPosition(input: OpenPosition): OpenPosition {
  return {
    tokenAddress: input.tokenAddress,
    planId: input.planId,
    sizeSol: Number.isFinite(input.sizeSol) ? input.sizeSol : 0,
    openedAt: input.openedAt,
    status: input.status,
  };
}

function buildOpenPositionsFromActiveTrades(activeTrades: ActiveTradeSnapshot): OpenPosition[] {
  return Object.entries(activeTrades).flatMap(([tokenAddress, trade]) => {
    const sizeSol = Number(trade.positionSol ?? trade.sizeSol ?? 0);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      return [];
    }

    return [{
      tokenAddress,
      planId: typeof trade.planId === "string" ? trade.planId : `live:${tokenAddress}`,
      sizeSol,
      openedAt: typeof trade.openedAt === "string" ? trade.openedAt : new Date(0).toISOString(),
      status: "open",
    } satisfies OpenPosition];
  });
}

function syncTrackedPositions(positions: OpenPosition[], activeTrades: ActiveTradeSnapshot): void {
  if (!isDatabaseEnabled()) {
    return;
  }

  const db = getDatabase();
  const replaceLivePositions = db.transaction((nextPositions: OpenPosition[]) => {
    db.prepare("DELETE FROM tracked_positions WHERE mode = 'live'").run();

    const insertPosition = db.prepare(`
      INSERT INTO tracked_positions (
        position_key,
        mint,
        whale_address,
        mode,
        status,
        opened_at,
        position_sol,
        remaining_position_fraction,
        payload_json,
        updated_at
      ) VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)
    `);

    for (const position of nextPositions) {
      const payload = activeTrades[position.tokenAddress] ?? {
        planId: position.planId,
        positionSol: position.sizeSol,
        openedAt: position.openedAt,
      };
      const remainingPositionFraction = Number(payload.remainingPositionFraction ?? 1);

      insertPosition.run(
        position.tokenAddress,
        position.tokenAddress,
        typeof payload.whale === "string" ? payload.whale : null,
        position.status,
        position.openedAt,
        position.sizeSol,
        Number.isFinite(remainingPositionFraction) ? remainingPositionFraction : 1,
        JSON.stringify(payload, null, 2),
        new Date().toISOString(),
      );
    }
  });

  replaceLivePositions(positions);
}

export async function loadTradePlans(): Promise<TradePlan[]> {
  if (!isDatabaseEnabled()) {
    return loadJsonFile<TradePlan[]>(PLANS_FILE, []);
  }

  const db = getDatabase();
  const rows = db.prepare(`
    SELECT payload_json
    FROM trade_plans
    ORDER BY created_at DESC, plan_id ASC
  `).all() as TradePlanRow[];

  if (rows.length === 0) {
    const legacyPlans = await loadJsonFile<TradePlan[]>(PLANS_FILE, []);
    if (legacyPlans.length > 0) {
      for (const plan of legacyPlans) {
        await saveTradePlan(plan);
      }
    }
    return legacyPlans;
  }

  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json) as TradePlan];
    } catch (error) {
      console.warn("Konnte Trade-Plan nicht parsen:", error);
      return [];
    }
  });
}

export async function saveTradePlan(plan: TradePlan): Promise<void> {
  if (!isDatabaseEnabled()) {
    const plans = await loadTradePlans();
    plans.push(plan);
    await saveJsonFile(PLANS_FILE, plans);
    return;
  }

  const db = getDatabase();
  db.prepare(`
    INSERT INTO trade_plans (plan_id, token_address, dex_id, pool_address, execution_mode, created_at, payload_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      token_address = excluded.token_address,
      dex_id = excluded.dex_id,
      pool_address = excluded.pool_address,
      execution_mode = excluded.execution_mode,
      created_at = excluded.created_at,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    plan.planId,
    plan.tokenAddress,
    plan.dexId ?? null,
    plan.poolAddress ?? null,
    plan.executionMode ?? null,
    plan.createdAt,
    JSON.stringify(plan, null, 2),
    new Date().toISOString(),
  );

  const plans = await loadTradePlans();
  const nextPlans = plans.filter((item) => item.planId !== plan.planId);
  nextPlans.unshift(plan);
  await saveJsonFile(PLANS_FILE, nextPlans);
}

export async function loadOpenPositions(): Promise<OpenPosition[]> {
  const activeTrades = await loadJsonFile<ActiveTradeSnapshot>(ACTIVE_TRADES_FILE, {});
  const openPositions = buildOpenPositionsFromActiveTrades(activeTrades).map(normalizeOpenPosition);
  syncTrackedPositions(openPositions, activeTrades);
  return openPositions;
}

export async function saveOpenPositions(positions: OpenPosition[]): Promise<void> {
  const normalizedPositions = positions.map(normalizeOpenPosition);

  if (isDatabaseEnabled()) {
    const activeTradeSnapshot = Object.fromEntries(normalizedPositions.map((position) => [position.tokenAddress, {
      planId: position.planId,
      positionSol: position.sizeSol,
      openedAt: position.openedAt,
      status: position.status,
    }]));
    syncTrackedPositions(normalizedPositions, activeTradeSnapshot);
  }

  await saveJsonFile(POSITIONS_FILE, normalizedPositions);
}
