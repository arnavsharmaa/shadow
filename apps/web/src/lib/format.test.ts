import { describe, expect, it } from "vitest";
import {
  classNames,
  compact,
  duration,
  money,
  percent,
  pluralize,
  relativeTime,
  shortId,
} from "./format";

describe("format helpers", () => {
  it("formats money with sensible precision and an estimate-friendly zero", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.0048775)).toBe("$0.0049");
    expect(money(0.000051)).toBe("$0.000051");
    expect(money(12.5)).toBe("$12.50");
    expect(money(1, "EUR")).toBe("EUR 1.00");
    expect(money(null)).toBe("–");
  });

  it("formats durations across units", () => {
    expect(duration(0.4)).toBe("<1ms");
    expect(duration(120)).toBe("120ms");
    expect(duration(4710)).toBe("4.71s");
    expect(duration(90_000)).toBe("1.5m");
    expect(duration(undefined)).toBe("–");
  });

  it("formats signed percentages and handles missing ratios", () => {
    expect(percent(-0.409)).toBe("-40.9%");
    expect(percent(0.0032)).toBe("+0.3%");
    expect(percent(null)).toBe("n/a");
  });

  it("compacts large numbers", () => {
    expect(compact(623)).toBe("623");
    expect(compact(12_400)).toBe("12.4K");
  });

  it("renders relative time", () => {
    const now = Date.parse("2026-09-03T12:00:00.000Z");
    expect(relativeTime("2026-09-03T11:59:30.000Z", now)).toBe("30s ago");
    expect(relativeTime("2026-09-03T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-09-03T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-01T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("shortens prefixed ids and joins class names", () => {
    expect(shortId("evt_db5d403fad605e21afc330f7")).toBe("evt_db5d403f");
    expect(shortId("main")).toBe("main");
    expect(classNames("a", false, undefined, "b")).toBe("a b");
    expect(pluralize(1, "trace")).toBe("1 trace");
    expect(pluralize(2, "trace")).toBe("2 traces");
  });
});
