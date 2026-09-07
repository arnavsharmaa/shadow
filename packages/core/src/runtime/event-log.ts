import type {
  EstimatedCost,
  JsonObject,
  JsonValue,
  Severity,
  ShadowEvent,
  TokenUsage,
} from "@shadow/schemas";
import { SCHEMA_VERSION } from "@shadow/schemas";
import { isoTimestamp, type Clock } from "../clock.js";
import type { IdGenerator } from "../ids.js";

export interface EmitInput {
  eventType: string;
  name: string;
  input?: JsonValue;
  output?: JsonValue;
  parentEventId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  durationMs?: number | null;
  severity?: Severity;
  tags?: string[];
  metadata?: JsonObject;
  tokenUsage?: TokenUsage | null;
  estimatedCost?: EstimatedCost | null;
  stateVersion?: number | null;
  correlationId?: string | null;
  /** Timestamp override (ms); defaults to the clock. */
  at?: number;
}

export interface EventLogOptions {
  traceId: string;
  branchId: string;
  ids: IdGenerator;
  clock: Clock;
  source: string;
  startSequence?: number;
  /** Merged into every event's metadata (e.g. `{ shadow: { origin: "replay" } }`). */
  baseMetadata?: JsonObject;
  /** Called for each emitted event (streaming persistence). */
  sink?: (event: ShadowEvent) => void;
}

/** Append-only in-memory event log with monotonically increasing sequences. */
export class EventLog {
  readonly events: ShadowEvent[] = [];
  private sequence: number;
  private readonly options: EventLogOptions;

  constructor(options: EventLogOptions) {
    this.options = options;
    this.sequence = options.startSequence ?? 0;
  }

  get traceId() {
    return this.options.traceId;
  }
  get branchId() {
    return this.options.branchId;
  }
  get nextSequence() {
    return this.sequence;
  }

  newSpanId(): string {
    return this.options.ids.next("spn");
  }

  emit(input: EmitInput): ShadowEvent {
    const metadata = mergeMetadata(this.options.baseMetadata, input.metadata);
    const event: ShadowEvent = {
      id: this.options.ids.next("evt"),
      schemaVersion: SCHEMA_VERSION,
      traceId: this.options.traceId,
      branchId: this.options.branchId,
      parentEventId: input.parentEventId ?? null,
      spanId: input.spanId ?? null,
      parentSpanId: input.parentSpanId ?? null,
      sequence: this.sequence++,
      timestamp: isoTimestamp(input.at ?? this.options.clock.now()),
      durationMs: input.durationMs ?? null,
      eventType: input.eventType,
      source: this.options.source,
      severity: input.severity ?? "info",
      name: input.name,
      metadata,
      tags: input.tags ?? [],
      tokenUsage: input.tokenUsage ?? null,
      estimatedCost: input.estimatedCost ?? null,
      stateVersion: input.stateVersion ?? null,
      correlationId: input.correlationId ?? null,
    };
    if (input.input !== undefined) event.input = input.input;
    if (input.output !== undefined) event.output = input.output;
    this.events.push(event);
    this.options.sink?.(event);
    return event;
  }
}

function mergeMetadata(base: JsonObject | undefined, extra: JsonObject | undefined): JsonObject {
  if (!base) return { ...(extra ?? {}) };
  if (!extra) return structuredClone(base);
  const merged: JsonObject = { ...structuredClone(base), ...extra };
  const baseShadow = base.shadow;
  const extraShadow = extra.shadow;
  if (isObj(baseShadow) && isObj(extraShadow)) merged.shadow = { ...baseShadow, ...extraShadow };
  return merged;
}

function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
