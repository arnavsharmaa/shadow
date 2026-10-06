import type { AuditEntry } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { describeAudit } from "./audit";

const entry = (action: string, details: Record<string, unknown>, targetId = "tgt"): AuditEntry =>
  ({
    id: "aud_1",
    at: "2026-10-06T09:00:00.000Z",
    actor: "arnav",
    action,
    targetType: "trace",
    targetId,
    traceId: null,
    details,
    requestId: null,
  }) as AuditEntry;

describe("describeAudit", () => {
  it("phrases the common actions with their details", () => {
    expect(describeAudit(entry("fork.created", { name: "limit-100" }))).toBe("forked limit-100");
    expect(describeAudit(entry("replay.run", { status: "completed" }, "br_1"))).toBe(
      "replayed br_1 (completed)",
    );
    expect(describeAudit(entry("branch.updated", { changes: { name: "reviewed" } }, "br_1"))).toBe(
      "renamed br_1 to reviewed",
    );
    expect(describeAudit(entry("traces.pruned", { deleted: 3, before: "2026-01-01" }))).toBe(
      "pruned 3 trace(s) started before 2026-01-01",
    );
    expect(describeAudit(entry("key.created", { name: "ci", scope: "ingest" }))).toBe(
      "created API key ci (ingest)",
    );
    expect(
      describeAudit(entry("collection.traces_added", { name: "incident", traceIds: ["a", "b"] })),
    ).toBe("added 2 trace(s) to collection incident");
  });

  it("falls back to a label, appending a name when there is one", () => {
    expect(describeAudit(entry("view.saved", { name: "costly failures" }))).toBe(
      "saved a shared view: costly failures",
    );
    expect(describeAudit(entry("trace.updated", {}))).toBe("updated the trace");
    expect(describeAudit(entry("something.new", {}))).toBe("something.new");
  });
});
