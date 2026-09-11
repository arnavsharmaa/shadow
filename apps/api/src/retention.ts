import type { Logger } from "pino";
import type { ApiConfig } from "./config.js";
import type { ServiceContext } from "./services/context.js";
import { pruneTraces } from "./services/traces.js";

const DAY_MS = 86_400_000;
/** Traces deleted per prune call; keeps each transaction short. */
const BATCH = 500;
/** Upper bound on batches per sweep so a huge backlog cannot monopolise the server. */
const MAX_BATCHES = 20;

export interface RetentionSweep {
  cutoff: string;
  deleted: number;
  /** More traces remained after MAX_BATCHES; the next sweep continues. */
  truncated: boolean;
}

export interface Retention {
  enabled: boolean;
  /** Run one sweep now; resolves to `null` when retention is disabled. */
  runOnce(): Promise<RetentionSweep | null>;
  /** Start the periodic timer (runs a sweep immediately). */
  start(): void;
  stop(): void;
}

/**
 * Periodic deletion of traces older than SHADOW_RETENTION_DAYS. Sweeps are
 * batched and bounded so they never block ingestion for long; anything left
 * over is picked up by the next interval.
 */
export function createRetention(input: {
  services: ServiceContext;
  config: Pick<ApiConfig, "SHADOW_RETENTION_DAYS" | "SHADOW_RETENTION_INTERVAL_MINUTES">;
  logger: Logger;
}): Retention {
  const { services, config, logger } = input;
  const days = config.SHADOW_RETENTION_DAYS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<RetentionSweep | null> | null = null;

  const sweep = async (): Promise<RetentionSweep | null> => {
    if (days === undefined) return null;
    const cutoff = new Date(services.clock.now() - days * DAY_MS).toISOString();
    let deleted = 0;
    let truncated = false;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await pruneTraces(services, { before: cutoff, dryRun: false, limit: BATCH });
      deleted += result.matched;
      truncated = result.truncated;
      if (!truncated) break;
    }
    if (deleted > 0 || truncated) {
      logger.info({ cutoff, deleted, truncated, retentionDays: days }, "retention sweep");
    }
    return { cutoff, deleted, truncated };
  };

  const runOnce = (): Promise<RetentionSweep | null> => {
    // Never overlap sweeps: a slow database plus a short interval would otherwise pile up.
    running ??= sweep().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    enabled: days !== undefined,
    runOnce,
    start() {
      if (days === undefined || timer) return;
      const intervalMs = config.SHADOW_RETENTION_INTERVAL_MINUTES * 60_000;
      const tick = () => {
        runOnce().catch((error: unknown) => {
          logger.error({ err: error }, "retention sweep failed");
        });
      };
      timer = setInterval(tick, intervalMs);
      timer.unref();
      logger.info(
        { retentionDays: days, intervalMinutes: config.SHADOW_RETENTION_INTERVAL_MINUTES },
        "retention enabled",
      );
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
