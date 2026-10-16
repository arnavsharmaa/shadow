import type {
  CreateArtifactBodyInput,
  CreateTraceBody,
  IngestEventInput,
  UpdateTraceBody,
} from "@shadow/schemas";
import type { TraceHandle, Transport } from "./transport.js";

/**
 * A transport that writes everything it is given as newline-delimited JSON records instead of
 * talking to an API, for runs that happen where the API is not reachable (CI jobs, air-gapped
 * batch runs, laptops offline). `shadow spool send <file>` later replays the records against
 * an API in order. Records are self-contained, so files can be concatenated or sent twice:
 * a trace that already exists is skipped with its records.
 */
export type SpoolRecord =
  | { kind: "trace"; body: CreateTraceBody & { id: string } }
  | { kind: "events"; traceId: string; events: IngestEventInput[] }
  | { kind: "artifact"; traceId: string; artifact: CreateArtifactBodyInput }
  | { kind: "update"; traceId: string; update: UpdateTraceBody };

export interface SpoolTransportOptions {
  /** Appends one line (already newline-terminated) to the spool. */
  append: (line: string) => Promise<void> | void;
  /** Trace ids when the caller gave none (default: random `trc_…`). */
  nextTraceId?: () => string;
}

function randomTraceId(): string {
  return `trc_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

export class SpoolTransport implements Transport {
  readonly #append: SpoolTransportOptions["append"];
  readonly #nextTraceId: () => string;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: SpoolTransportOptions) {
    this.#append = options.append;
    this.#nextTraceId = options.nextTraceId ?? randomTraceId;
  }

  /**
   * A spool that appends to a file through Node's `fs` (imported on first use, so the SDK
   * stays loadable where there is no file system). The file and its directory are created.
   */
  static toFile(path: string, options: Omit<SpoolTransportOptions, "append"> = {}): SpoolTransport {
    type Fs = {
      appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
      mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    };
    let ready: Promise<Fs> | undefined;
    const fs = () => (ready ??= import("node:fs/promises") as Promise<Fs>);
    let created = false;
    return new SpoolTransport({
      ...options,
      append: async (line) => {
        const { appendFile, mkdir } = await fs();
        if (!created) {
          const dir = path.replace(/[\\/][^\\/]*$/, "");
          if (dir && dir !== path) await mkdir(dir, { recursive: true });
          created = true;
        }
        await appendFile(path, line, "utf8");
      },
    });
  }

  /** Records are written strictly in the order they were handed over. */
  #write(record: SpoolRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.#chain = this.#chain.then(() => this.#append(line));
    return this.#chain;
  }

  async createTrace(body: CreateTraceBody): Promise<TraceHandle> {
    const id = body.id ?? this.#nextTraceId();
    await this.#write({ kind: "trace", body: { ...body, id } });
    // The API assigns the root branch when the spool is sent; events never name a branch.
    return { id, rootBranchId: `${id}_main` };
  }

  async sendEvents(traceId: string, events: IngestEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await this.#write({ kind: "events", traceId, events });
  }

  async sendArtifact(traceId: string, artifact: CreateArtifactBodyInput): Promise<void> {
    await this.#write({ kind: "artifact", traceId, artifact });
  }

  async updateTrace(traceId: string, update: UpdateTraceBody): Promise<void> {
    await this.#write({ kind: "update", traceId, update });
  }

  /** Resolves once every record handed over so far has been appended. */
  settle(): Promise<void> {
    return this.#chain;
  }
}

/** Parse a spool file's text into records, reporting the line of anything malformed. */
export function parseSpool(text: string): {
  records: SpoolRecord[];
  errors: { line: number; message: string }[];
} {
  const records: SpoolRecord[] = [];
  const errors: { line: number; message: string }[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const record = parsed as Partial<SpoolRecord> | null;
    const kind = record && typeof record === "object" ? record.kind : undefined;
    const ok =
      (kind === "trace" && typeof (record as { body?: { id?: unknown } }).body?.id === "string") ||
      ((kind === "events" || kind === "artifact" || kind === "update") &&
        typeof (record as { traceId?: unknown }).traceId === "string");
    if (!ok) {
      errors.push({ line: index + 1, message: `not a spool record (kind ${String(kind)})` });
      continue;
    }
    records.push(parsed as SpoolRecord);
  }
  return { records, errors };
}
