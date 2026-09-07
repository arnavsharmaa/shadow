export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Advance virtual time (no-op for real clocks). */
  advance(ms: number): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  advance: () => undefined,
};

/** A clock whose time only moves when told to; the basis of reproducible timestamps. */
export class VirtualClock implements Clock {
  private current: number;
  constructor(start: number | string | Date) {
    this.current = typeof start === "number" ? start : new Date(start).getTime();
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    if (ms < 0 || !Number.isFinite(ms))
      throw new Error("cannot advance clock by a negative amount");
    this.current += ms;
  }
}

export function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
