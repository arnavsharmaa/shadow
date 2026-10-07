import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceExportSchema } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileExporter, safePathComponent } from "../../src/export/file.js";
import { createLogger } from "../../src/logger.js";
import { createTestApp, ingestRefundScenario, json, type TestApp } from "../helpers.js";

let t: TestApp;
let dir: string;

beforeAll(async () => {
  t = await createTestApp();
  dir = await mkdtemp(join(tmpdir(), "shadow-export-"));
});

afterAll(async () => {
  await t.close();
  await rm(dir, { recursive: true, force: true });
});

describe("file export", () => {
  it("keeps path components to id and slug characters", () => {
    expect(safePathComponent("support-agent")).toBe("support-agent");
    expect(safePathComponent("trc_demo.1")).toBe("trc_demo.1");
    expect(safePathComponent("../etc/passwd")).toBe("__etc_passwd");
    expect(safePathComponent("..")).toBe("_");
    expect(safePathComponent("")).toBe("_");
  });

  it("writes every finished trace as an importable bundle", async () => {
    t.services.fileExporter = createFileExporter({
      config: { SHADOW_EXPORT_DIR: dir },
      logger: createLogger({ level: "silent" }),
    });
    expect(t.services.fileExporter.enabled).toBe(true);
    const scenario = await ingestRefundScenario(t, "trc_test_file_export", {
      seed: "file-export",
    });
    await t.services.fileExporter.settle();

    const file = join(dir, "support-agent", "trc_test_file_export.json");
    expect(await readdir(join(dir, "support-agent"))).toEqual(["trc_test_file_export.json"]);
    const bundle = traceExportSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(bundle.format).toBe("shadow.trace");
    expect(bundle.trace.id).toBe(scenario.traceId);
    expect(bundle.project.slug).toBe("support-agent");
    expect(bundle.events.length).toBe(scenario.rootEvents.length);

    // The bundle round-trips through the import endpoint (an import is not a finish, so it
    // does not write a second file).
    await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${scenario.traceId}` });
    const imported = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/import",
      payload: { bundle },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(json<{ id: string }>(imported).id).toBe(scenario.traceId);
    expect(t.services.metrics.fileExports.render().join("\n")).toContain(
      'shadow_file_exports_total{result="written"} 1',
    );

    // A trace that only started is not written; a directory that cannot be used is counted.
    const started = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "support-agent", agent: "a", name: "still running" },
    });
    await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${json<{ id: string }>(started).id}/events`,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    await t.services.fileExporter.settle();
    expect(await readdir(join(dir, "support-agent"))).toEqual(["trc_test_file_export.json"]);

    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    t.services.fileExporter = createFileExporter({
      config: { SHADOW_EXPORT_DIR: blocker },
      logger: createLogger({ level: "silent" }),
    });
    await ingestRefundScenario(t, "trc_test_file_export_2", { seed: "file-export-2" });
    await t.services.fileExporter.settle();
    expect(t.services.metrics.fileExports.render().join("\n")).toContain(
      'shadow_file_exports_total{result="failed"} 1',
    );
  });

  it("does nothing when no directory is configured", async () => {
    const exporter = createFileExporter({
      config: { SHADOW_EXPORT_DIR: undefined },
      logger: createLogger({ level: "silent" }),
    });
    expect(exporter.enabled).toBe(false);
    await exporter.traceFinished(t.services, "trc_nothing");
    await exporter.settle();
  });
});
