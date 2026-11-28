import { describe, expect, it } from "vitest";
import { countBundles, EXPORT_LIMIT, exportHint, exportNotice } from "./export";

describe("countBundles", () => {
  it("counts one bundle per non-empty line", () => {
    expect(countBundles("")).toBe(0);
    expect(countBundles('{"a":1}\n')).toBe(1);
    expect(countBundles('{"a":1}\n{"a":2}\n')).toBe(2);
    // No trailing newline, and a blank line in between, change nothing.
    expect(countBundles('{"a":1}\n\n{"a":2}')).toBe(2);
  });
});

describe("exportNotice", () => {
  it("says how many traces left", () => {
    expect(exportNotice(1, 1)).toBe("Exported 1 trace");
    expect(exportNotice(3, 3)).toBe("Exported 3 traces");
  });

  it("says when the export stopped short of what the filters match", () => {
    expect(exportNotice(EXPORT_LIMIT, 742)).toBe("Exported the newest 500 traces of 742");
    expect(exportNotice(1, 2)).toBe("Exported the newest 1 trace of 2");
  });

  it("does not call a list that shrank in the meantime a cut", () => {
    // The total is the list's, read earlier; more bundles than that is still a whole export.
    expect(exportNotice(4, 3)).toBe("Exported 4 traces");
  });

  it("says so when nothing matched", () => {
    expect(exportNotice(0, 0)).toBe("No traces match the filters");
    expect(exportNotice(0, 5)).toBe("No traces match the filters");
  });
});

describe("exportHint", () => {
  it("promises every trace up to the cap, and the newest ones beyond it", () => {
    expect(exportHint(3)).toMatch(/^Download every trace matching the current filters/);
    expect(exportHint(EXPORT_LIMIT)).toMatch(/^Download every trace/);
    expect(exportHint(EXPORT_LIMIT + 1)).toMatch(/^Download the newest 500 of the 501 traces/);
  });
});
