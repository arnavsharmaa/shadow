import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
  );

const configSchema = z.object({
  DATABASE_URL: z.string().optional(),
  SHADOW_DATA_DIR: z.string().default(".shadow/data"),
  SHADOW_API_HOST: z.string().default("127.0.0.1"),
  SHADOW_API_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  SHADOW_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  SHADOW_AUTO_MIGRATE: boolish.default(true),
  SHADOW_AUTO_SEED: boolish.default(true),
  SHADOW_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),
  SHADOW_REDACT_PATTERNS: z.string().default(""),
  SHADOW_CORS_ORIGINS: z.string().default("http://localhost:3000,http://127.0.0.1:3000"),
  /** Comma-separated ES modules exporting AgentDefinitions to make replayable. */
  SHADOW_REPLAY_MODULES: z.string().default(""),
  /** When set, every /api/* request must carry `Authorization: Bearer <token>`. */
  SHADOW_API_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  /** Delete traces older than this many days (unset disables retention). */
  SHADOW_RETENTION_DAYS: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || (typeof v === "string" && v.trim() === "")) return undefined;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: "must be a positive number of days" });
        return z.NEVER;
      }
      return n;
    }),
  /** How often the retention sweep runs (minutes). */
  SHADOW_RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(60),
  NODE_ENV: z.string().default("development"),
});

export type ApiConfig = z.infer<typeof configSchema>;

/** Load `.env` from the repo root (or cwd) without overriding real env vars. */
export function loadDotEnv(): void {
  const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(repoRoot(), ".env")];
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        // Ignore malformed .env files; explicit env always wins.
      }
      return;
    }
  }
}

/** Nearest ancestor directory containing `pnpm-workspace.yaml`, else cwd. */
export function repoRoot(from: string = process.cwd()): string {
  let current = path.resolve(from);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(from);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  if (!path.isAbsolute(config.SHADOW_DATA_DIR)) {
    config.SHADOW_DATA_DIR = path.resolve(repoRoot(), config.SHADOW_DATA_DIR);
  }
  return config;
}

export function corsOrigins(config: ApiConfig): string[] {
  return config.SHADOW_CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
