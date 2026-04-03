import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { resolveConfiguredPath } from "../utils/repo-paths.js";
import { loadJsonDocument, saveJsonDocument } from "./database.js";

async function ensureStoreDir(): Promise<string> {
  const storeDir = resolveConfiguredPath(env.STORE_PATH);
  await mkdir(storeDir, { recursive: true });
  return storeDir;
}

export async function loadJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const storeDir = await ensureStoreDir();
  const filePath = path.join(storeDir, fileName);
  return loadJsonDocument(filePath, fallback);
}

export async function saveJsonFile<T>(fileName: string, value: T): Promise<void> {
  const storeDir = await ensureStoreDir();
  const filePath = path.join(storeDir, fileName);
  await saveJsonDocument(filePath, value);
}
