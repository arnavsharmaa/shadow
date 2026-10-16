import { describe, expect, it } from "vitest";
import { Shadow, SpoolTransport, parseSpool, type SpoolRecord } from "../src/index.js";

function spool() {
  const lines: string[] = [];
  const transport = new SpoolTransport({
    append: (line) => {
      lines.push(line);
    },
    nextTraceId: () => "trc_spooled",
  });
  return { transport, lines, text: () => lines.join("") };
}

describe("SpoolTransport", () => {
  it("writes a trace, its events, artifacts and updates as ordered NDJSON records", async () => {
    const { transport, lines, text } = spool();
    const shadow = new Shadow({ project: "ci", agent: "nightly", transport, flushIntervalMs: 0 });
    const trace = shadow.startTrace({ name: "run 42", tags: ["ci"] });
    await trace.tool({ name: "lint", arguments: {}, execute: () => ({ ok: true }) });
    trace.artifact({ kind: "report", name: "lint.txt", content: "all good" });
    trace.tag("green");
    await trace.end();
    await transport.settle();

    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    const { records, errors } = parseSpool(text());
    expect(errors).toEqual([]);
    expect(records.map((r) => r.kind)).toEqual(["trace", "events", "artifact", "update"]);
    const first = records[0] as Extract<SpoolRecord, { kind: "trace" }>;
    // The SDK names its traces itself; the spool keeps that id on every record.
    expect(first.body).toMatchObject({
      id: trace.traceId,
      project: "ci",
      agent: "nightly",
      name: "run 42",
    });
    expect(trace.traceId).toMatch(/^trc_/);
    const events = records[1] as Extract<SpoolRecord, { kind: "events" }>;
    expect(events.traceId).toBe(trace.traceId);
    expect(events.events.map((e) => e.eventType)).toEqual([
      "trace.started",
      "agent.started",
      "tool.request",
      "tool.response",
      "agent.completed",
      "trace.completed",
    ]);
    expect(events.events.every((e) => !("branchId" in e) || e.branchId === undefined)).toBe(true);
    expect((records[2] as Extract<SpoolRecord, { kind: "artifact" }>).artifact).toMatchObject({
      kind: "report",
      name: "lint.txt",
    });
    expect((records[3] as Extract<SpoolRecord, { kind: "update" }>).update).toMatchObject({
      addTags: ["green"],
    });
    expect(records.slice(1).every((r) => r.kind !== "trace" && r.traceId === trace.traceId)).toBe(
      true,
    );
  });

  it("keeps caller-provided ids, skips empty batches and preserves order under concurrency", async () => {
    const seen: string[] = [];
    const transport = new SpoolTransport({
      append: async (line) => {
        // A slow sink must not reorder records.
        await new Promise((resolve) => setTimeout(resolve, line.includes('"trace"') ? 5 : 0));
        seen.push(line);
      },
    });
    const handle = await transport.createTrace({
      project: "p",
      agent: "a",
      name: "n",
      id: "trc_mine",
    });
    expect(handle).toEqual({ id: "trc_mine", rootBranchId: "trc_mine_main" });
    await transport.sendEvents("trc_mine", []);
    await transport.sendEvents("trc_mine", [{ eventType: "trace.started", name: "trace.started" }]);
    await transport.settle();
    const { records } = parseSpool(seen.join(""));
    expect(records.map((r) => r.kind)).toEqual(["trace", "events"]);
    const generated = await new SpoolTransport({ append: () => undefined }).createTrace({
      project: "p",
      agent: "a",
      name: "n",
    });
    expect(generated.id).toMatch(/^trc_[0-9a-f]{32}$/);
  });

  it("reports malformed lines without losing the rest", () => {
    const { records, errors } = parseSpool(
      [
        '{"kind":"trace","body":{"id":"trc_1","project":"p","agent":"a","name":"n"}}',
        "",
        "not json",
        '{"kind":"events","events":[]}',
        '{"kind":"events","traceId":"trc_1","events":[]}',
        '{"kind":"other"}',
      ].join("\n"),
    );
    expect(records.map((r) => r.kind)).toEqual(["trace", "events"]);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 6]);
    expect(errors[1]?.message).toBe("not a spool record (kind events)");
  });

  it("appends to a file through toFile, creating the directory", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "shadow-spool-"));
    const path = join(dir, "nested", "run.ndjson");
    try {
      const transport = SpoolTransport.toFile(path, { nextTraceId: () => "trc_file" });
      await transport.createTrace({ project: "p", agent: "a", name: "n" });
      await transport.sendEvents("trc_file", [
        { eventType: "trace.started", name: "trace.started" },
      ]);
      await transport.settle();
      const { records, errors } = parseSpool(await readFile(path, "utf8"));
      expect(errors).toEqual([]);
      expect(records.map((r) => r.kind)).toEqual(["trace", "events"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
