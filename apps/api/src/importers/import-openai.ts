import { ingestEventsBodySchema, type ImportOpenAIBody } from "@shadow/schemas";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { ingestEvents } from "../services/events.js";
import { createTrace } from "../services/traces.js";
import { convertOpenAIMessages, type OpenAIConversion } from "./openai.js";

export interface OpenAIImportResult {
  traceId: string;
  name: string;
  events: number;
  summary: OpenAIConversion["summary"];
}

/** Store a Chat Completions conversation as a new trace of `source: "openai"`. */
export const DEFAULT_OPENAI_IMPORT_PROJECT = "openai";

export async function importOpenAIMessages(
  ctx: ServiceContext,
  body: ImportOpenAIBody,
): Promise<OpenAIImportResult> {
  const converted = convertOpenAIMessages(body, {
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
      project: body.project ?? DEFAULT_OPENAI_IMPORT_PROJECT,
      agent: body.agent,
      name: converted.name,
      startedAt: converted.startedAt,
      tags: [...new Set(["openai", ...body.tags])],
      metadata: {
        ...(body.metadata ?? {}),
        openai: { ...(body.model ? { model: body.model } : {}), turns: converted.summary.turns },
      },
    },
    { source: "openai" },
  );
  await ingestEvents(ctx, trace.id, parsed.data);
  return {
    traceId: trace.id,
    name: converted.name,
    events: converted.events.length,
    summary: converted.summary,
  };
}
