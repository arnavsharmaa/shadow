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
