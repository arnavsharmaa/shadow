import type { Logger } from "pino";
import type { ApiConfig } from "./config.js";
import type { ServiceContext } from "./services/context.js";
import { pruneTraces } from "./services/traces.js";
import { pruneAudit, recordAudit } from "./services/audit.js";

const DAY_MS = 86_400_000;
/** Traces deleted per prune call; keeps each transaction short. */
const BATCH = 500;
/** Upper bound on batches per sweep so a huge backlog cannot monopolise the server. */
const MAX_BATCHES = 20;

export interface RetentionSweep {
  /** Traces that started before this were deleted; `null` when trace retention is off. */
  cutoff: string | null;
  deleted: number;
  /** More traces remained after MAX_BATCHES; the next sweep continues. */
  truncated: boolean;
  /** Audit entries deleted under SHADOW_AUDIT_RETENTION_DAYS. */
  auditDeleted: number;
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
  config: Pick<
    ApiConfig,
    | "SHADOW_RETENTION_DAYS"
    | "SHADOW_RETENTION_INTERVAL_MINUTES"
    | "SHADOW_RETENTION_KEEP_TAG"
    | "SHADOW_AUDIT_RETENTION_DAYS"
  >;
  logger: Logger;
}): Retention {
  const { services, config, logger } = input;
  const days = config.SHADOW_RETENTION_DAYS;
  const auditDays = config.SHADOW_AUDIT_RETENTION_DAYS;
  const enabled = days !== undefined || auditDays !== undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<RetentionSweep | null> | null = null;

  const sweep = async (): Promise<RetentionSweep | null> => {
    if (!enabled) return null;
    let auditDeleted = 0;
    if (auditDays !== undefined) {
      const before = new Date(services.clock.now() - auditDays * DAY_MS).toISOString();
      auditDeleted = await pruneAudit(services, before);
      if (auditDeleted > 0) logger.info({ before, auditDeleted }, "audit log pruned");
    }
    if (days === undefined) return { cutoff: null, deleted: 0, truncated: false, auditDeleted };
    const cutoff = new Date(services.clock.now() - days * DAY_MS).toISOString();
    let deleted = 0;
    let truncated = false;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const result = await pruneTraces(services, {
        before: cutoff,
        dryRun: false,
        limit: BATCH,
        excludeTag: config.SHADOW_RETENTION_KEEP_TAG,
      });
      deleted += result.matched;
      if (result.traceIds.length > 0) {
        await recordAudit(services, {
          actor: "system:retention",
          action: "traces.pruned",
          targetType: "trace",
          targetId: result.traceIds.length === 1 ? (result.traceIds[0] ?? "-") : "*",
          details: {
            before: cutoff,
            deleted: result.traceIds.length,
            traceIds: result.traceIds.slice(0, 100),
            retentionDays: days,
          },
        });
      }
      truncated = result.truncated;
      if (!truncated) break;
    }
    if (deleted > 0 || truncated) {
      logger.info(
        {
          cutoff,
          deleted,
          truncated,
          retentionDays: days,
          keepTag: config.SHADOW_RETENTION_KEEP_TAG,
        },
        "retention sweep",
      );
    }
    return { cutoff, deleted, truncated, auditDeleted };
  };

  const runOnce = (): Promise<RetentionSweep | null> => {
    // Never overlap sweeps: a slow database plus a short interval would otherwise pile up.
    running ??= sweep().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    enabled,
    runOnce,
    start() {
      if (!enabled || timer) return;
      const intervalMs = config.SHADOW_RETENTION_INTERVAL_MINUTES * 60_000;
      const tick = () => {
        runOnce().catch((error: unknown) => {
          logger.error({ err: error }, "retention sweep failed");
        });
      };
      timer = setInterval(tick, intervalMs);
      timer.unref();
      logger.info(
        {
          retentionDays: days ?? null,
          auditRetentionDays: auditDays ?? null,
          intervalMinutes: config.SHADOW_RETENTION_INTERVAL_MINUTES,
          keepTag: config.SHADOW_RETENTION_KEEP_TAG,
        },
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
