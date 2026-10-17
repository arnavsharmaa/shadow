import { describe, expect, it } from "vitest";
import { csvField, csvLine } from "../../src/http/csv.js";

describe("csv", () => {
  it("quotes only what needs quoting and doubles quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("has, comma")).toBe('"has, comma"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(42)).toBe("42");
    expect(csvField(true)).toBe("true");
    expect(csvField({ a: 1, b: "x" })).toBe('"{""a"":1,""b"":""x""}"');
    expect(csvLine(["a", "b,c", null])).toBe('a,"b,c",\r\n');
  });
});
