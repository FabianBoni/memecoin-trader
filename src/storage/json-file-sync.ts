import { loadJsonDocumentSync, saveJsonDocumentSync } from "./database.js";

export function readJsonFileSync<T>(filePath: string, fallback: T): T {
  return loadJsonDocumentSync(filePath, fallback);
}

export function writeJsonFileSync<T>(filePath: string, value: T): void {
  saveJsonDocumentSync(filePath, value);
}