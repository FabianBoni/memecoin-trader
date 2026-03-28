import path from 'path';
import { fileURLToPath } from 'url';
import { readJsonFileSync, writeJsonFileSync } from './json-file-sync.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_STATUS_PATH = path.resolve(SCRIPT_DIR, '../data/runtime-status.json');

export type RuntimeStatusSection = Record<string, unknown>;
export type RuntimeStatusStore = Record<string, RuntimeStatusSection>;

export function readRuntimeStatus(): RuntimeStatusStore {
  return readJsonFileSync<RuntimeStatusStore>(RUNTIME_STATUS_PATH, {});
}

export function updateRuntimeStatus(section: string, patch: RuntimeStatusSection) {
  const status = readRuntimeStatus();
  status[section] = {
    ...(status[section] ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFileSync(RUNTIME_STATUS_PATH, status);
}
