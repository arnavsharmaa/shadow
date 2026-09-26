import { describe, expect, it } from "vitest";
import { parseHeaderList } from "../../src/otlp/forwarder.js";

describe("parseHeaderList", () => {
  it("parses comma or newline separated name=value pairs", () => {
    expect(parseHeaderList("authorization=Bearer a=b, X-Tenant = support\nx-empty=")).toEqual({
      authorization: "Bearer a=b",
      "x-tenant": "support",
    });
  });

  it("ignores blanks and malformed entries", () => {
    expect(parseHeaderList(undefined)).toEqual({});
    expect(parseHeaderList("  ,=nope, novalue ")).toEqual({});
  });
});
