import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { importOtlpTraces } from "../../otlp/import.js";
import type { OtlpTracesPayload } from "../../otlp/convert.js";

/** OTLP/HTTP JSON `ExportTraceServiceRequest`; validated structurally during conversion. */
const otlpTracesBodySchema = z.looseObject({
  resourceSpans: z.array(z.record(z.string(), z.unknown())).max(10_000).default([]),
});

export interface OtlpRouteOptions {
  defaultProject: string;
}

/**
 * OpenTelemetry ingestion. Point an OTLP/HTTP exporter at
 * `<api>/api/v1/otlp` (JSON encoding); the standard `/v1/traces` suffix lands here.
 */
export const otlpRoutes: FastifyPluginAsyncZod<OtlpRouteOptions> = async (app, options) => {
  app.post(
    "/otlp/v1/traces",
    { schema: { tags: ["otlp"], body: otlpTracesBodySchema } },
    async (request) => {
      const result = await importOtlpTraces(
        app.services,
        request.body as unknown as OtlpTracesPayload,
        { defaultProject: options.defaultProject },
      );
      // `partialSuccess` is the OTLP success envelope; `shadow` reports what was stored.
      return { partialSuccess: {}, shadow: result };
    },
  );
};
