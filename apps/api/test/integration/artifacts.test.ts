import type { Artifact, Trace, TraceExport } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, ingestRefundScenario, json, type TestApp } from "../helpers.js";

let t: TestApp;
let traceId: string;
let rootBranchId: string;
let emailEventId: string;

beforeAll(async () => {
  t = await createTestApp();
  const scenario = await ingestRefundScenario(t, "trc_artifacts");
  traceId = scenario.traceId;
  rootBranchId = scenario.rootBranchId;
  const email = scenario.rootEvents.find(
    (e) => e.eventType === "tool.response" && e.name === "send_email",
  );
  if (!email) throw new Error("send_email response not found");
  emailEventId = email.id;
});

afterAll(async () => {
  await t.close();
});

describe("artifacts", () => {
  it("creates, links, redacts and lists artifacts", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/artifacts`,
      payload: {
        eventId: emailEventId,
        kind: "email",
        name: "customer-email",
        contentType: "text/markdown",
        content: { subject: "Your refund", body: "Hi Jordan", authorization: "Bearer x" },
      },
    });
    expect(created.statusCode).toBe(201);
    const artifact = json<Artifact>(created);
    expect(artifact).toMatchObject({
      traceId,
      branchId: rootBranchId,
      eventId: emailEventId,
      kind: "email",
      contentType: "text/markdown",
    });
    expect(artifact.content).toEqual({
      subject: "Your refund",
      body: "Hi Jordan",
      authorization: "[REDACTED]",
    });

    const second = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/artifacts`,
      payload: { kind: "report", name: "summary", content: "plain text works too" },
    });
    expect(second.statusCode).toBe(201);
    expect(json<Artifact>(second).contentType).toBe("application/json");

    const all = json<{ items: Artifact[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}/artifacts` }),
    );
    expect(all.items.map((a) => a.name)).toEqual(["customer-email", "summary"]);
    const byEvent = json<{ items: Artifact[] }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${traceId}/artifacts?eventId=${emailEventId}`,
      }),
    );
    expect(byEvent.items).toHaveLength(1);
    const one = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${traceId}/artifacts/${artifact.id}`,
    });
    expect(one.statusCode).toBe(200);
    expect(json<Artifact>(one).id).toBe(artifact.id);
  });

  it("rejects unknown traces, events and invalid bodies", async () => {
    const missingTrace = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/trc_nope/artifacts",
      payload: { kind: "k", name: "n", content: {} },
    });
    expect(missingTrace.statusCode).toBe(404);
    const missingEvent = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/artifacts`,
      payload: { kind: "k", name: "n", content: {}, eventId: "evt_missing" },
    });
    expect(missingEvent.statusCode).toBe(404);
    const invalid = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/artifacts`,
      payload: { kind: "", name: "n" },
    });
    expect(invalid.statusCode).toBe(400);
    const unknownArtifact = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${traceId}/artifacts/art_missing`,
    });
    expect(unknownArtifact.statusCode).toBe(404);
  });

  it("round-trips artifacts through export and import with regenerated ids", async () => {
    const bundle = json<TraceExport>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}/export` }),
    );
    expect(bundle.artifacts).toHaveLength(2);
    const imported = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/import",
      payload: { bundle, idStrategy: "regenerate" },
    });
    expect(imported.statusCode).toBe(201);
    const copy = json<Trace>(imported);
    const copied = json<{ items: Artifact[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${copy.id}/artifacts` }),
    );
    expect(copied.items).toHaveLength(2);
    const linked = copied.items.find((a) => a.name === "customer-email");
    expect(linked?.eventId).toBeTruthy();
    expect(linked?.eventId).not.toBe(emailEventId);
    expect(linked?.branchId).toBe(copy.rootBranchId);
    const event = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${copy.id}/events/${linked?.eventId}`,
    });
    expect(event.statusCode).toBe(200);
  });
});
