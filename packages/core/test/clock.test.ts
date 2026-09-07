import { describe, expect, it } from "vitest";
import { VirtualClock, isoTimestamp, systemClock } from "../src/index.js";

describe("VirtualClock", () => {
  it("starts at the given number, ISO string or Date", () => {
    expect(new VirtualClock(1000).now()).toBe(1000);
    expect(new VirtualClock("2026-09-01T09:00:00.000Z").now()).toBe(
      Date.parse("2026-09-01T09:00:00.000Z"),
    );
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(new VirtualClock(date).now()).toBe(date.getTime());
  });

  it("only moves when advanced", () => {
    const clock = new VirtualClock(0);
    expect(clock.now()).toBe(0);
    expect(clock.now()).toBe(0);
    clock.advance(250);
    expect(clock.now()).toBe(250);
    clock.advance(0);
    expect(clock.now()).toBe(250);
  });

  it("rejects negative or non-finite advances", () => {
    const clock = new VirtualClock(10);
    expect(() => clock.advance(-1)).toThrow(/negative/);
    expect(() => clock.advance(Number.NaN)).toThrow();
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow();
    expect(clock.now()).toBe(10);
  });
});

describe("systemClock", () => {
  it("tracks wall-clock time and ignores advance()", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now() + 1000);
    expect(() => systemClock.advance(5000)).not.toThrow();
    expect(systemClock.now()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("isoTimestamp", () => {
  it("formats milliseconds as an ISO-8601 UTC string", () => {
    expect(isoTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoTimestamp(Date.parse("2026-09-01T09:12:04.000Z"))).toBe("2026-09-01T09:12:04.000Z");
  });
});
