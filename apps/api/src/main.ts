import { createRedactor, parsePatternList } from "@shadow/core";
import { loadConfig, loadDotEnv, repoRoot } from "./config.js";
import { createDatabase } from "./db/client.js";
import { buildApp } from "./http/app.js";
import { createLogger } from "./logger.js";
import { createDefaultRegistry, loadReplayModules, parseModuleList } from "./replay/registry.js";
import { createRetention } from "./retention.js";
import { isDatabaseEmpty, seedDemoData } from "./seed/seed.js";
import { createServiceContext } from "./services/context.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({
    level: config.SHADOW_LOG_LEVEL,
    pretty: process.stdout.isTTY && config.NODE_ENV !== "production",
    redactPatterns: config.SHADOW_REDACT_PATTERNS,
  });

  const handle = await createDatabase({
    url: config.DATABASE_URL,
    dataDir: config.SHADOW_DATA_DIR,
  });
  logger.info({ database: handle.location, kind: handle.kind }, "database connected");
  if (config.SHADOW_AUTO_MIGRATE) {
    await handle.migrate();
    logger.info("migrations applied");
  }

  const registry = createDefaultRegistry();
  for (const loaded of await loadReplayModules(
    registry,
    parseModuleList(config.SHADOW_REPLAY_MODULES, repoRoot()),
  )) {
    logger.info({ module: loaded.modulePath, agents: loaded.slugs }, "replay module loaded");
  }

  const services = createServiceContext({
    handle,
    logger,
    registry,
    redactor: createRedactor({
      additionalKeyPatterns: parsePatternList(config.SHADOW_REDACT_PATTERNS),
    }),
  });

  if (config.SHADOW_AUTO_SEED && (await isDatabaseEmpty(services))) {
    logger.info("database is empty; seeding demo data");
    await seedDemoData(services);
  }

  const app = await buildApp({ config, services, logger });
  const retention = createRetention({ services, config, logger });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      logger.error("shutdown timed out; exiting");
      process.exit(1);
    }, 10_000);
    timer.unref();
    try {
      retention.stop();
      await app.close();
      await handle.close();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled promise rejection");
  });

  await app.listen({ host: config.SHADOW_API_HOST, port: config.SHADOW_API_PORT });
  retention.start();
  logger.info(
    {
      url: `http://${config.SHADOW_API_HOST}:${config.SHADOW_API_PORT}`,
      docs: `http://${config.SHADOW_API_HOST}:${config.SHADOW_API_PORT}/docs`,
    },
    "shadow api listening",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
