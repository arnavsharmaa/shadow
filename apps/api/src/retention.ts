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
  /** Per-project passes under SHADOW_RETENTION_PROJECT_DAYS, in configuration order. */
  projects: {
    project: string;
    days: number;
    cutoff: string;
    /** Includes the project's failed traces deleted under SHADOW_RETENTION_FAILED_DAYS. */
    deleted: number;
    truncated: boolean;
  }[];
  /** The global pass over failed traces under SHADOW_RETENTION_FAILED_DAYS; `null` without it. */
  failed: { days: number; cutoff: string; deleted: number; truncated: boolean } | null;
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
  > &
    Partial<
      Pick<
        ApiConfig,
        | "SHADOW_RETENTION_PROJECT_DAYS"
        | "SHADOW_RETENTION_KEEP_COLLECTED"
        | "SHADOW_RETENTION_FAILED_DAYS"
      >
    >;
  logger: Logger;
}): Retention {
  const { services, config, logger } = input;
  const days = config.SHADOW_RETENTION_DAYS;
  const failedDays = config.SHADOW_RETENTION_FAILED_DAYS;
  const auditDays = config.SHADOW_AUDIT_RETENTION_DAYS;
  const perProject = Object.entries(config.SHADOW_RETENTION_PROJECT_DAYS ?? {});
  const keepCollected = config.SHADOW_RETENTION_KEEP_COLLECTED ?? true;
  const enabled = days !== undefined || auditDays !== undefined || perProject.length > 0;
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
    /**
     * One bounded, audited prune pass over traces older than `retentionDays`. With
     * SHADOW_RETENTION_FAILED_DAYS set, `status` narrows a pass to failed traces (on their own
     * clock) or to everything else.
     */
    const pass = async (
      retentionDays: number,
      project?: string,
      status?: "failed" | "not_failed",
    ) => {
      const cutoff = new Date(services.clock.now() - retentionDays * DAY_MS).toISOString();
      let deleted = 0;
      let truncated = false;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const result = await pruneTraces(
          services,
          {
            before: cutoff,
            dryRun: false,
            limit: BATCH,
            excludeTag: config.SHADOW_RETENTION_KEEP_TAG,
            keepCollected,
            ...(project ? { project } : {}),
            ...(status === "failed" ? { status: "failed" as const } : {}),
          },
          {
            // The global pass leaves projects with their own retention alone.
            ...(project ? {} : { excludeProjects: perProject.map(([slug]) => slug) }),
            ...(status === "not_failed" ? { excludeStatus: "failed" as const } : {}),
          },
        );
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
              retentionDays,
              ...(project ? { project } : {}),
              ...(status === "failed" ? { status: "failed" } : {}),
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
            retentionDays,
            ...(project ? { project } : {}),
            ...(status === "failed" ? { status: "failed" } : {}),
            keepTag: config.SHADOW_RETENTION_KEEP_TAG,
            keepCollected,
          },
          "retention sweep",
        );
      }
      return { cutoff, deleted, truncated };
    };
    /** A project's or the global window, with failed traces on their own clock when configured. */
    const window = async (retentionDays: number, project?: string) => {
      if (failedDays === undefined) return pass(retentionDays, project);
      const kept = await pass(retentionDays, project, "not_failed");
      const failed = await pass(failedDays, project, "failed");
      return {
        cutoff: kept.cutoff,
        deleted: kept.deleted + failed.deleted,
        truncated: kept.truncated || failed.truncated,
      };
    };
    const projects: RetentionSweep["projects"] = [];
    for (const [project, projectDays] of perProject) {
      projects.push({ project, days: projectDays, ...(await window(projectDays, project)) });
    }
    if (days === undefined) {
      return { cutoff: null, deleted: 0, truncated: false, auditDeleted, projects, failed: null };
    }
    if (failedDays === undefined) {
      return { ...(await pass(days)), auditDeleted, projects, failed: null };
    }
    const kept = await pass(days, undefined, "not_failed");
    const failed = await pass(failedDays, undefined, "failed");
    return { ...kept, auditDeleted, projects, failed: { days: failedDays, ...failed } };
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
          failedRetentionDays: failedDays ?? null,
          auditRetentionDays: auditDays ?? null,
          ...(perProject.length > 0 ? { projectDays: Object.fromEntries(perProject) } : {}),
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
