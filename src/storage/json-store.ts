import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

async function ensureStoreDir(): Promise<string> {
  const storeDir = path.resolve(process.cwd(), env.STORE_PATH);
  await mkdir(storeDir, { recursive: true });
  return storeDir;
}

export async function loadJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const storeDir = await ensureStoreDir();
  const filePath = path.join(storeDir, fileName);

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return fallback;
    }
    throw error;
  }
}

export async function saveJsonFile<T>(fileName: string, value: T): Promise<void> {
  const storeDir = await ensureStoreDir();
  const filePath = path.join(storeDir, fileName);
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
