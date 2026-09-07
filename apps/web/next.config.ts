import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Separate build directory for the E2E suite so it never collides with a
  // running dev server or a production build.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  // Trace files from the monorepo root so the standalone bundle includes workspace packages.
  outputFileTracingRoot: path.resolve(here, "../.."),
  transpilePackages: ["@shadow/schemas", "@shadow/core"],
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages are consumed from TypeScript source and use
  // ESM-style `./file.js` specifiers; map them back to `.ts`/`.tsx`.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  },
};

export default nextConfig;
