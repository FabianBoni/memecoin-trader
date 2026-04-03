import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: path.join(__dirname, ".."),
  serverExternalPackages: ["better-sqlite3"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;