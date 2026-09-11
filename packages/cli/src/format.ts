/** Small, dependency-free formatting helpers for terminal output. */

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function money(amount: number | undefined | null, currency = "USD"): string {
  if (amount === undefined || amount === null) return "-";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (amount === 0) return `${symbol}0`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(6)}`;
  return `${symbol}${amount.toFixed(4)}`;
}

export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function percent(value: number | null): string {
  if (value === null) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

/** Parse `key=value` where value is JSON when possible, else a string. */
export function parseAssignment(input: string): { key: string; value: unknown } {
  const index = input.indexOf("=");
  if (index <= 0) throw new Error(`expected key=value but got '${input}'`);
  const key = input.slice(0, index).trim();
  const raw = input.slice(index + 1);
  try {
    return { key, value: JSON.parse(raw) };
  } catch {
    return { key, value: raw };
  }
}

const RELATIVE = /^(\d+)\s*(m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Turn a cutoff argument into an ISO timestamp. Accepts an ISO date/time or a
 * relative age such as `30d`, `12h`, `45m` or `2w` (measured from `now`).
 */
export function parseCutoff(input: string, now: Date = new Date()): string {
  const relative = RELATIVE.exec(input.trim());
  if (relative) {
    const amount = Number.parseInt(relative[1] ?? "0", 10);
    const unit = (relative[2] ?? "d").toLowerCase();
    return new Date(now.getTime() - amount * (UNIT_MS[unit] ?? 86_400_000)).toISOString();
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`expected an ISO timestamp or a relative age like 30d, got '${input}'`);
  }
  return date.toISOString();
}
