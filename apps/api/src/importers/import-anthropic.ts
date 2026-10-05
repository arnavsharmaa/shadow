import { ingestEventsBodySchema, type ImportAnthropicBody } from "@shadow/schemas";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { ingestEvents } from "../services/events.js";
import { createTrace } from "../services/traces.js";
import { convertAnthropicMessages, type AnthropicConversion } from "./anthropic.js";

export interface AnthropicImportResult {
  traceId: string;
  name: string;
  events: number;
  summary: AnthropicConversion["summary"];
}

/** Store a Messages API conversation as a new trace of `source: "anthropic"`. */
export const DEFAULT_IMPORT_PROJECT = "anthropic";

export async function importAnthropicMessages(
  ctx: ServiceContext,
  body: ImportAnthropicBody,
): Promise<AnthropicImportResult> {
  const converted = convertAnthropicMessages(body, {
    nextId: (prefix) => ctx.ids.next(prefix),
    now: ctx.clock.now(),
  });
  const parsed = ingestEventsBodySchema.safeParse({ events: converted.events });
  if (!parsed.success) {
    throw ApiError.badRequest("the conversation maps to invalid events", parsed.error.issues);
  }
  const trace = await createTrace(
    ctx,
    {
      id: body.traceId,
      project: body.project ?? DEFAULT_IMPORT_PROJECT,
      agent: body.agent,
      name: converted.name,
      startedAt: converted.startedAt,
      tags: [...new Set(["anthropic", ...body.tags])],
      metadata: {
        ...(body.metadata ?? {}),
        anthropic: { ...(body.model ? { model: body.model } : {}), turns: converted.summary.turns },
      },
    },
    { source: "anthropic" },
  );
  await ingestEvents(ctx, trace.id, parsed.data);
  return {
    traceId: trace.id,
    name: converted.name,
    events: converted.events.length,
    summary: converted.summary,
  };
}
