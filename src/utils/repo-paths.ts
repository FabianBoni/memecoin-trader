import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT_ENV_KEY = "MEMECOIN_TRADER_REPO_ROOT";

let cachedRepoRoot: string | null = null;

function isRepoRoot(candidate: string): boolean {
  const packageJsonPath = path.join(candidate, "package.json");
  const srcDir = path.join(candidate, "src");
  const dbDir = path.join(candidate, "db");

  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(srcDir) || !fs.existsSync(dbDir)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return packageJson.name === "memecoin-trader";
  } catch {
    return false;
  }
}

function findRepoRootFrom(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (isRepoRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function resolveCandidateRepoRoot(candidate: string | undefined): string | null {
  if (!candidate || candidate.trim().length === 0) {
    return null;
  }

  return findRepoRootFrom(candidate);
}

export function resolveRepoRoot(): string {
  if (cachedRepoRoot) {
    return cachedRepoRoot;
  }

  const repoRoot = [
    resolveCandidateRepoRoot(process.env[REPO_ROOT_ENV_KEY]),
    resolveCandidateRepoRoot(process.cwd()),
    resolveCandidateRepoRoot(path.dirname(fileURLToPath(import.meta.url))),
  ].find((candidate): candidate is string => candidate !== null);

  if (!repoRoot) {
    throw new Error("Unable to resolve repository root.");
  }

  cachedRepoRoot = repoRoot;
  return repoRoot;
}

export function resolveRepoPath(...segments: string[]): string {
  return path.join(resolveRepoRoot(), ...segments);
}

export function resolveConfiguredPath(configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(resolveRepoRoot(), configuredPath);
}

export function resolveSrcDataPath(...segments: string[]): string {
  return resolveRepoPath("src", "data", ...segments);
}

export function repoRelativePath(filePath: string): string {
  return path.relative(resolveRepoRoot(), path.resolve(filePath)).replaceAll("\\", "/") || ".";
}