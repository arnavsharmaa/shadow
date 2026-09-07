import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { schema } from "./schema.js";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  kind: "pglite" | "postgres";
  /** Human readable location (no credentials). */
  location: string;
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  /** Drop every Shadow table (used by `db:reset` and tests). */
  reset(): Promise<void>;
}

export interface DatabaseConfig {
  /** `postgres://...` for PostgreSQL; `pglite://<dir>`, `memory://` or empty for embedded. */
  url?: string;
  /** Default PGlite data directory when `url` is empty. */
  dataDir?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate the migrations folder both from `src/` (tsx) and `dist/` (bundled). */
export function migrationsFolder(): string {
  const candidates = [
    path.resolve(here, "../../drizzle"),
    path.resolve(here, "../drizzle"),
    path.resolve(process.cwd(), "drizzle"),
    path.resolve(process.cwd(), "apps/api/drizzle"),
  ];
  const found = candidates.find((candidate) =>
    existsSync(path.join(candidate, "meta", "_journal.json")),
  );
  if (!found) {
    throw new Error(`migrations folder not found (looked in ${candidates.join(", ")})`);
  }
  return found;
}

const RESET_STATEMENTS = [
  "DROP TABLE IF EXISTS artifacts, comparisons, replays, forks, state_snapshots, events, branches, traces, agents, projects CASCADE",
  "DROP SCHEMA IF EXISTS drizzle CASCADE",
];

async function resetSchema(db: Database): Promise<void> {
  for (const statement of RESET_STATEMENTS) await db.execute(sql.raw(statement));
}

export async function createDatabase(config: DatabaseConfig = {}): Promise<DatabaseHandle> {
  const url = config.url?.trim() ?? "";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema });
    const location = describePostgresUrl(url);
    return {
      db,
      kind: "postgres",
      location,
      migrate: () => migratePg(db, { migrationsFolder: migrationsFolder() }),
      ping: async () => {
        try {
          await pool.query("select 1");
          return true;
        } catch {
          return false;
        }
      },
      close: () => pool.end(),
      reset: () => resetSchema(db),
    };
  }
  const memory = url === "memory://" || url === "pglite://memory";
  const dataDir = memory
    ? undefined
    : url.startsWith("pglite://")
      ? url.slice("pglite://".length)
      : config.dataDir;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzlePglite(client, { schema });
  return {
    db,
    kind: "pglite",
    location: dataDir ? `pglite:${dataDir}` : "pglite:memory",
    migrate: () => migratePglite(db, { migrationsFolder: migrationsFolder() }),
    ping: async () => {
      try {
        await client.query("select 1");
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
    reset: () => resetSchema(db),
  };
}

function describePostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `postgres://${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "postgres://(unparseable url)";
  }
}
