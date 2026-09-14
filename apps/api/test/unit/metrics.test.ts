import { describe, expect, it } from "vitest";
import { Counter, Histogram, ShadowMetrics } from "../../src/metrics/registry.js";

describe("metrics registry", () => {
  it("renders counters with sorted label sets and escaped values", () => {
    const c = new Counter("x_total", "Things.", ["route", "status"]);
    c.inc({ route: "/b", status: "200" });
    c.inc({ route: "/a", status: "500" }, 3);
    c.inc({ route: "/b", status: "200" });
    c.inc({ route: 'q"uo\\te\n', status: "200" });
    expect(c.get({ route: "/b", status: "200" })).toBe(2);
    expect(c.get({ route: "/none", status: "0" })).toBe(0);
    expect(c.render()).toEqual([
      "# HELP x_total Things.",
      "# TYPE x_total counter",
      'x_total{route="/a",status="500"} 3',
      'x_total{route="/b",status="200"} 2',
      'x_total{route="q\\"uo\\\\te\\n",status="200"} 1',
    ]);
    const plain = new Counter("y_total", "Plain.");
    plain.inc();
    expect(plain.render()).toEqual([
      "# HELP y_total Plain.",
      "# TYPE y_total counter",
      "y_total 1",
    ]);
  });

  it("renders cumulative histogram buckets", () => {
    const h = new Histogram("d_ms", "Durations.", ["route"], [10, 100]);
    h.observe({ route: "/a" }, 5);
    h.observe({ route: "/a" }, 50);
    h.observe({ route: "/a" }, 500);
    expect(h.render()).toEqual([
      "# HELP d_ms Durations.",
      "# TYPE d_ms histogram",
      'd_ms_bucket{route="/a",le="10"} 1',
      'd_ms_bucket{route="/a",le="100"} 2',
      'd_ms_bucket{route="/a",le="+Inf"} 3',
      'd_ms_sum{route="/a"} 555',
      'd_ms_count{route="/a"} 3',
    ]);
  });

  it("renders the full exposition with process and sampled gauges", () => {
    const m = new ShadowMetrics();
    m.tracesCreated.inc({ source: "api" });
    const text = m.render([{ name: "shadow_traces", help: "Traces stored.", value: 7 }]);
    expect(text).toContain('shadow_traces_created_total{source="api"} 1');
    expect(text).toContain("# TYPE shadow_http_request_duration_ms histogram");
    expect(text).toContain("# TYPE process_uptime_seconds gauge");
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
    expect(text).toContain("shadow_traces 7");
    expect(text.endsWith("\n")).toBe(true);
  });
});
