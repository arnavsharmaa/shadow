import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ApiConfig } from "../config.js";
import type { ServiceContext } from "../services/context.js";
import { exportTrace } from "../services/transfer.js";

export interface FileExporterOptions {
  config: Pick<ApiConfig, "SHADOW_EXPORT_DIR">;
  logger: Logger;
}

export interface FileExporter {
  enabled: boolean;
  /** Write the trace's bundle under the export directory; resolves when written. Never throws. */
  traceFinished(ctx: ServiceContext, traceId: string): Promise<void>;
  /** Outstanding writes, so shutdown can wait for them. */
  settle(): Promise<void>;
}

/** A path component made of the characters ids and slugs are validated to; anything else is `_`. */
export function safePathComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.replace(/^\.+/, "_") || "_";
}

/**
 * Writes every finished trace as a self-contained bundle (the `shadow.trace` format of
 * `GET /traces/:id/export`) to `<SHADOW_EXPORT_DIR>/<project>/<traceId>.json`, so an archive,
 * a sync job or `shadow traces import` can pick it up. Like the OTLP forwarder, writing happens
 * off the ingestion path: failures are logged and counted, never surfaced to the client. Each
 * file is written next to its final name and renamed into place, so readers never see a
 * partial bundle.
 */
export function createFileExporter(options: FileExporterOptions): FileExporter {
  const dir = options.config.SHADOW_EXPORT_DIR;
  const inflight = new Set<Promise<void>>();

  const write = async (ctx: ServiceContext, traceId: string): Promise<void> => {
    if (!dir) return;
    try {
      const bundle = await exportTrace(ctx, traceId);
      const folder = join(dir, safePathComponent(bundle.project.slug));
      await mkdir(folder, { recursive: true });
      const file = join(folder, `${safePathComponent(traceId)}.json`);
      const partial = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(partial, JSON.stringify(bundle), "utf8");
      await rename(partial, file);
      options.logger.debug({ traceId, file }, "trace bundle written");
      ctx.metrics.fileExports.inc({ result: "written" });
    } catch (error) {
      options.logger.error({ traceId, dir, err: error }, "trace bundle export failed");
      ctx.metrics.fileExports.inc({ result: "failed" });
    }
  };

  return {
    enabled: dir !== undefined,
    async traceFinished(ctx, traceId) {
      if (!dir) return;
      const task = write(ctx, traceId).finally(() => inflight.delete(task));
      inflight.add(task);
      await task;
    },
    async settle() {
      await Promise.allSettled([...inflight]);
    },
  };
}
