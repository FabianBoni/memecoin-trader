import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, isDatabaseEnabled } from './database.js';
import { readJsonFileSync, writeJsonFileSync } from './json-file-sync.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_STATUS_PATH = path.resolve(SCRIPT_DIR, '../data/runtime-status.json');

export type RuntimeStatusSection = Record<string, unknown>;
export type RuntimeStatusStore = Record<string, RuntimeStatusSection>;

type RuntimeStatusRow = {
  section: string;
  payload_json: string;
};

function normalizeRuntimeStatusSection(input: unknown): RuntimeStatusSection {
  if (!input || typeof input !== 'object') {
    return {};
  }

  return input as RuntimeStatusSection;
}

function readRuntimeStatusFromDatabase(): RuntimeStatusStore {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT section, payload_json
    FROM runtime_status
    ORDER BY section ASC
  `).all() as RuntimeStatusRow[];

  if (rows.length === 0) {
    const legacyStatus = readJsonFileSync<RuntimeStatusStore>(RUNTIME_STATUS_PATH, {});
    if (Object.keys(legacyStatus).length > 0) {
      writeRuntimeStatus(legacyStatus);
      return legacyStatus;
    }

    return {};
  }

  const store: RuntimeStatusStore = {};
  for (const row of rows) {
    try {
      store[row.section] = normalizeRuntimeStatusSection(JSON.parse(row.payload_json));
    } catch (error) {
      console.warn(`Konnte Runtime-Status fuer ${row.section} nicht parsen:`, error);
      store[row.section] = {};
    }
  }

  return store;
}

export function writeRuntimeStatus(store: RuntimeStatusStore) {
  if (!isDatabaseEnabled()) {
    writeJsonFileSync(RUNTIME_STATUS_PATH, store);
    return;
  }

  const normalizedEntries = Object.entries(store).map(([section, payload]) => [
    section,
    normalizeRuntimeStatusSection(payload),
  ] as const);
  const db = getDatabase();
  const upsertStatement = db.prepare(`
    INSERT INTO runtime_status (section, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const replaceAll = db.transaction((entries: ReadonlyArray<readonly [string, RuntimeStatusSection]>) => {
    for (const [section, payload] of entries) {
      upsertStatement.run(section, JSON.stringify(payload, null, 2), new Date().toISOString());
    }

    const sections = entries.map(([section]) => section);
    if (sections.length === 0) {
      db.prepare('DELETE FROM runtime_status').run();
      return;
    }

    const placeholders = sections.map(() => '?').join(', ');
    db.prepare(`DELETE FROM runtime_status WHERE section NOT IN (${placeholders})`).run(...sections);
  });

  replaceAll(normalizedEntries);
  writeJsonFileSync(RUNTIME_STATUS_PATH, Object.fromEntries(normalizedEntries));
}

export function readRuntimeStatus(): RuntimeStatusStore {
  if (isDatabaseEnabled()) {
    return readRuntimeStatusFromDatabase();
  }

  return readJsonFileSync<RuntimeStatusStore>(RUNTIME_STATUS_PATH, {});
}

export function updateRuntimeStatus(section: string, patch: RuntimeStatusSection) {
  if (!isDatabaseEnabled()) {
    const status = readRuntimeStatus();
    status[section] = {
      ...(status[section] ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeJsonFileSync(RUNTIME_STATUS_PATH, status);
    return;
  }

  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO runtime_status (section, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const updateSection = db.transaction((targetSection: string, targetPatch: RuntimeStatusSection) => {
    const existingRow = db.prepare(`
      SELECT payload_json
      FROM runtime_status
      WHERE section = ?
    `).get(targetSection) as RuntimeStatusRow | undefined;
    const existingSection = existingRow
      ? normalizeRuntimeStatusSection(JSON.parse(existingRow.payload_json))
      : {};
    const mergedSection = {
      ...existingSection,
      ...targetPatch,
      updatedAt: new Date().toISOString(),
    };

    upsert.run(targetSection, JSON.stringify(mergedSection, null, 2), mergedSection.updatedAt);
  });

  updateSection(section, patch);
  writeJsonFileSync(RUNTIME_STATUS_PATH, readRuntimeStatusFromDatabase());
}
