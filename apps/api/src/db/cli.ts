import { createRedactor, parsePatternList } from "@shadow/core";
import { loadConfig, loadDotEnv } from "../config.js";
import { createLogger } from "../logger.js";
import { createDefaultRegistry } from "../replay/registry.js";
import { seedDemoData } from "../seed/seed.js";
import { createServiceContext } from "../services/context.js";
import { createDatabase } from "./client.js";

const USAGE = `Usage: shadow-db <command>

Commands:
  migrate   Apply pending migrations
  seed      Seed the deterministic demo data (re-creates demo traces)
  reset     Drop all Shadow tables, re-run migrations and seed demo data
`;

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || !["migrate", "seed", "reset"].includes(command)) {
    process.stdout.write(USAGE);
    return command ? 1 : 0;
  }
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ level: config.SHADOW_LOG_LEVEL, pretty: process.stdout.isTTY });
  const handle = await createDatabase({
    url: config.DATABASE_URL,
    dataDir: config.SHADOW_DATA_DIR,
  });
  logger.info({ database: handle.location }, "connected");
  try {
    if (command === "reset") {
      await handle.reset();
      logger.info("dropped all tables");
    }
    await handle.migrate();
    logger.info("migrations applied");
    if (command === "seed" || command === "reset") {
      const services = createServiceContext({
        handle,
        logger,
        registry: createDefaultRegistry(),
        redactor: createRedactor({
          additionalKeyPatterns: parsePatternList(config.SHADOW_REDACT_PATTERNS),
        }),
      });
      const report = await seedDemoData(services, { force: true });
      logger.info({ seeded: report.seeded }, "seed complete");
    }
    return 0;
  } finally {
    await handle.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
