import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRepoPath, resolveRepoRoot } from "../utils/repo-paths.js";

const webDir = resolveRepoPath("web");
const lockFilePath = path.join(webDir, "package-lock.json");
const requiredPackages = [
  path.join(webDir, "node_modules", "next", "package.json"),
  path.join(webDir, "node_modules", "react", "package.json"),
  path.join(webDir, "node_modules", "react-dom", "package.json"),
  path.join(webDir, "node_modules", "typescript", "package.json"),
];

function hasWebDependencies(): boolean {
  return requiredPackages.every((filePath) => fs.existsSync(filePath));
}

function runNpmInstall(): void {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const useCi = fs.existsSync(lockFilePath);
  const args = [
    "--prefix",
    webDir,
    useCi ? "ci" : "install",
    "--include=dev",
    "--no-fund",
    "--no-audit",
  ];

  const result = spawnSync(npmCommand, args, {
    cwd: resolveRepoRoot(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to install web dependencies (exit ${result.status ?? 1}).`);
  }
}

if (hasWebDependencies()) {
  console.log("[WEB] Dependencies already installed.");
} else {
  console.log("[WEB] Missing dashboard dependencies. Installing web workspace packages...");
  runNpmInstall();
  console.log("[WEB] Dashboard dependencies installed.");
}