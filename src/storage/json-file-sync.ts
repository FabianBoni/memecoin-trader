import fs from "node:fs";
import path from "node:path";

export function readJsonFileSync<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      if (raw.trim().length === 0) {
        return fallback;
      }

      return JSON.parse(raw) as T;
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt === 1) {
        console.warn(`JSON read fallback for ${filePath}:`, error);
        return fallback;
      }
    }
  }

  return fallback;
}

export function writeJsonFileSync<T>(filePath: string, value: T): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const serialized = JSON.stringify(value, null, 2) + "\n";

  fs.writeFileSync(tempPath, serialized, "utf8");
  fs.renameSync(tempPath, filePath);
}