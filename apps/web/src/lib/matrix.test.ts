import { describe, expect, it } from "vitest";
import { matrixOverride, matrixVariantName, parseMatrixValues } from "./matrix";

describe("parseMatrixValues", () => {
  it("splits a single line of scalars on commas and parses JSON where possible", () => {
    expect(parseMatrixValues("50, 100, gold, true")).toEqual([50, 100, "gold", true]);
  });

  it("keeps one value per line and never splits JSON objects on commas", () => {
    expect(parseMatrixValues('{"status": "failed", "code": 1}\n{"status": "ok"}')).toEqual([
      { status: "failed", code: 1 },
      { status: "ok" },
    ]);
    expect(parseMatrixValues('{"a": 1, "b": 2}')).toEqual([{ a: 1, b: 2 }]);
    expect(parseMatrixValues('"a, b"')).toEqual(["a, b"]);
  });

  it("ignores blank lines and whitespace", () => {
    expect(parseMatrixValues("\n  1 \n\n 2\n")).toEqual([1, 2]);
    expect(parseMatrixValues("   ")).toEqual([]);
  });
});

describe("matrixOverride", () => {
  it("builds context, tool result and policy overrides", () => {
    expect(matrixOverride("context", " refundLimit ", 100)).toEqual({
      override: { kind: "context", op: "set", key: "refundLimit", value: 100 },
    });
    expect(matrixOverride("tool_result", "refund_order", { status: "failed" })).toEqual({
      override: {
        kind: "tool_result",
        tool: "refund_order",
        occurrence: 1,
        result: { status: "failed" },
      },
    });
    expect(matrixOverride("policy", "refund.autonomous_limit", { limit: 100 })).toEqual({
      override: { kind: "policy", policy: "refund.autonomous_limit", config: { limit: 100 } },
    });
  });

  it("rejects policy configurations that are not objects", () => {
    expect(matrixOverride("policy", "refund.autonomous_limit", 100)).toEqual({
      error: "policy configurations must be JSON objects",
    });
    expect(matrixOverride("policy", "p", [1])).toHaveProperty("error");
    expect(matrixOverride("policy", "p", null)).toHaveProperty("error");
  });
});

describe("matrixVariantName", () => {
  it("matches the CLI naming and stays within branch name limits", () => {
    expect(matrixVariantName("refundLimit", 100)).toBe("refundLimit=100");
    expect(matrixVariantName("tier", "gold")).toBe('tier="gold"');
    expect(matrixVariantName("x", "y".repeat(500))).toHaveLength(120);
  });
});
