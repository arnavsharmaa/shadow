/** The traces one export takes from a selection at most, as the API caps it. */
export const EXPORT_LIMIT = 500;

/** The file name the API gives a bulk export; `shadow traces import` reads it back. */
export const EXPORT_FILENAME = "shadow-traces.shadow.ndjson";

/** How many bundles a newline-delimited export holds: one per non-empty line. */
export function countBundles(text: string): number {
  return text.split("\n").filter((line) => line.length > 0).length;
}

/**
 * What an export of the traces matching the filters did, in one line. `total` is how many
 * traces the filters match; fewer bundles than that means the export stopped at its cap.
 */
export function exportNotice(exported: number, total: number): string {
  if (exported === 0) return "No traces match the filters";
  const traces = `${exported.toLocaleString()} trace${exported === 1 ? "" : "s"}`;
  return exported < total
    ? `Exported the newest ${traces} of ${total.toLocaleString()}`
    : `Exported ${traces}`;
}

/** What the export button will do, for its tooltip. */
export function exportHint(total: number): string {
  return total > EXPORT_LIMIT
    ? `Download the newest ${EXPORT_LIMIT} of the ${total.toLocaleString()} traces matching the current filters as bundles (one per line), ready for shadow traces import`
    : "Download every trace matching the current filters as bundles (one per line), ready for shadow traces import";
}

/** Hand the browser a text document as a file download. */
export function saveText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
