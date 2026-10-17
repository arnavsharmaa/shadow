import { auditListQuerySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { listAudit } from "../../services/audit.js";
import { csvLine } from "../csv.js";

/** Entries a CSV export may hold; the JSON listing pages beyond this with cursors. */
export const MAX_CSV_ENTRIES = 10_000;
const CSV_COLUMNS = [
  "at",
  "actor",
  "action",
  "targetType",
  "targetId",
  "traceId",
  "requestId",
  "details",
] as const;

/** The audit log: who forked, replayed, deleted, pruned or imported what. */
export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/audit",
    { schema: { tags: ["audit"], querystring: auditListQuerySchema } },
    async (request, reply) => {
      if (request.query.format !== "csv") return listAudit(app.services, request.query);
      // Follow the cursors server-side so the caller gets one document, newest first.
      const lines = [csvLine(CSV_COLUMNS)];
      let cursor = request.query.cursor;
      let count = 0;
      while (count < MAX_CSV_ENTRIES) {
        const page = await listAudit(app.services, {
          ...request.query,
          cursor,
          limit: Math.min(500, MAX_CSV_ENTRIES - count),
        });
        for (const entry of page.items) {
          lines.push(csvLine(CSV_COLUMNS.map((column) => entry[column])));
        }
        count += page.items.length;
        if (!page.nextCursor || page.items.length === 0) break;
        cursor = page.nextCursor;
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="shadow-audit.csv"');
      reply.header("x-shadow-truncated", count >= MAX_CSV_ENTRIES ? "true" : "false");
      return reply.send(lines.join(""));
    },
  );
};
