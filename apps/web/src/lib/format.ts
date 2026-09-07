export function money(amount: number | null | undefined, currency = "USD"): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "–";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (amount === 0) return `${symbol}0.00`;
  if (Math.abs(amount) < 0.001) return `${symbol}${amount.toFixed(6)}`;
  if (Math.abs(amount) < 1) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "–";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(11, 23)}`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const diff = now - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60_000, "s"],
    [3_600_000, "m"],
    [86_400_000, "h"],
    [Number.POSITIVE_INFINITY, "d"],
  ];
  let value = abs / 1000;
  let unit = "s";
  for (const [limit, u] of units) {
    unit = u;
    if (abs < limit) break;
    value = abs / (limit === Number.POSITIVE_INFINITY ? 86_400_000 : limit);
  }
  if (unit === "s") return `${Math.round(abs / 1000)}s ago`;
  if (unit === "m") return `${Math.round(abs / 60_000)}m ago`;
  if (unit === "h") return `${Math.round(abs / 3_600_000)}h ago`;
  return `${Math.round(value)}d ago`;
}

export function shortId(id: string, keep = 8): string {
  const index = id.indexOf("_");
  const prefix = index > 0 ? id.slice(0, index + 1) : "";
  const rest = index > 0 ? id.slice(index + 1) : id;
  return rest.length > keep ? `${prefix}${rest.slice(0, keep)}` : id;
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function classNames(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
