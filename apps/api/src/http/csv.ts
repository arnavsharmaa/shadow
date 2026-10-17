/** RFC 4180 CSV: fields with commas, quotes or line breaks are quoted, quotes doubled. */
export function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}
