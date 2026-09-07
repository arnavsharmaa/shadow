import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const apiPort = Number(process.env.SHADOW_E2E_API_PORT ?? 4100);
const webPort = Number(process.env.SHADOW_E2E_WEB_PORT ?? 3100);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const dataDir = path.resolve(here, "../../.shadow/e2e");

/**
 * The E2E suite boots an isolated API (embedded PGlite in .shadow/e2e, seeded
 * with the deterministic demo data) and the Next.js dev server, then drives
 * the canonical refund workflow through the browser.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `pnpm --filter @shadow/api exec tsx src/main.ts`,
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: process.env.SHADOW_E2E_DATABASE_URL ?? `pglite://${dataDir}-${process.pid}`,
        SHADOW_API_PORT: String(apiPort),
        SHADOW_API_HOST: "127.0.0.1",
        SHADOW_AUTO_MIGRATE: "true",
        SHADOW_AUTO_SEED: "true",
        SHADOW_LOG_LEVEL: "warn",
        SHADOW_CORS_ORIGINS: `${webUrl},http://localhost:${webPort}`,
      },
    },
    {
      command: `pnpm --filter @shadow/web exec next dev --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_SHADOW_API_URL: apiUrl,
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
});
