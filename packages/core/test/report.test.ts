import { describe, expect, it } from "vitest";
import { parseBundle } from "../src/bundle/bundle.js";
import {
  describeOverride,
  formatDuration,
  formatMoney,
  traceReportMarkdown,
} from "../src/report/markdown.js";
import { makeBranch, makeBundle, makeEvent, makeFork } from "./helpers.js";

describe("trace report", () => {
  it("renders a summary table, the execution tree and the branches", () => {
    const raw = makeBundle({
      trace: { name: "refund | defective headphones", tags: ["refund", "vip"] },
      events: [
        makeEvent({ sequence: 0, eventType: "trace.started", name: "trace.started" }),
        makeEvent({
          sequence: 1,
          eventType: "tool.request",
          name: "lookup_order",
          spanId: "spn_1",
          input: { tool: "lookup_order", arguments: { orderId: "ord_1", note: "a|b" } },
        }),
        makeEvent({
          sequence: 2,
          eventType: "tool.error",
          name: "lookup_order",
          parentEventId: "evt_1",
          spanId: "spn_1",
          durationMs: 1250,
          output: { error: { message: "order not found" } },
        }),
        makeEvent({
          sequence: 3,
          eventType: "policy.evaluated",
          name: "refund.autonomous_limit",
          output: { decision: "approval_required", reason: "amount over limit" },
        }),
        makeEvent({
          sequence: 4,
          eventType: "trace.completed",
          name: "trace.completed",
          output: { outcome: { kind: "approval_pending", label: "Approval pending" } },
        }),
      ],
    });
    const bundle = parseBundle({
      ...raw,
      trace: {
        ...raw.trace,
        outcome: { kind: "approval_pending", label: "Approval pending" },
        metrics: {
          ...raw.trace.metrics,
          totalEstimatedCost: 0.0123,
          totalTokens: 420,
          inputTokens: 300,
          outputTokens: 120,
          modelCalls: 2,
          toolCalls: 1,
          toolErrors: 1,
        },
      },
    });
    const md = traceReportMarkdown(bundle);
    expect(md.startsWith("# refund | defective headphones\n")).toBe(true);
    expect(md).toContain("| Outcome | Approval pending (`approval_pending`) |");
    expect(md).toContain("| Estimated cost | $0.0123 |");
    expect(md).toContain("| Tokens | 420 (300 in / 120 out) |");
    expect(md).toContain("| Model calls / tool calls | 2 / 1 (1 tool errors) |");
    expect(md).toContain("| Tags | `refund`, `vip` |");
    expect(md).toContain(`## Execution (${bundle.branches[0]?.name ?? "?"})`);
    expect(md).toContain('- [1] `tool.request` lookup_order `{"orderId":"ord_1","note":"a|b"}`');
    expect(md).toContain("  - [2] `tool.error` lookup_order — order not found _1.3 s_");
    expect(md).toContain(
      "- [3] `policy.evaluated` refund.autonomous_limit → approval_required (amount over limit)",
    );
    expect(md).not.toContain("## Branches");
    expect(md.trim().endsWith("by Shadow (schema 1.0)._")).toBe(true);
  });

  it("caps the execution listing and lists forks with their overrides", () => {
    const raw = makeBundle({});
    const child = makeBranch({
      id: "br_child",
      traceId: raw.trace.id,
      name: "limit 100",
      parentBranchId: raw.trace.rootBranchId,
      forkSequence: 1,
      forkId: "frk_1",
      status: "completed",
    });
    const bundle = parseBundle({
      ...raw,
      branches: [...raw.branches, child],
      forks: [
        makeFork({
          id: "frk_1",
          traceId: raw.trace.id,
          parentBranchId: raw.trace.rootBranchId,
          childBranchId: "br_child",
          forkEventId: "evt_1",
          forkSequence: 1,
          overrides: [
            { kind: "context", op: "set", key: "refundLimit", value: 100 },
            { kind: "tool_error", tool: "charge", occurrence: 1, error: { message: "declined" } },
          ],
        }),
      ],
    });
    const md = traceReportMarkdown(bundle, { maxEvents: 2 });
    expect(md).toContain("## Branches");
    expect(md).toContain("| limit 100 (`br_child`) | completed |");
    const root = bundle.branches[0]?.name ?? "?";
    expect(md).toContain(
      `${root} at #1: context \`refundLimit\` = \`100\`; tool \`charge\` (call #1) fails: declined |`,
    );
    expect(md).toContain("- … 1 more events");
  });

  it("formats values and overrides consistently", () => {
    expect(formatMoney(0.5)).toBe("$0.5000");
    expect(formatMoney(12.345)).toBe("$12.35");
    expect(formatMoney(-0.25, "EUR")).toBe("-EUR 0.2500");
    expect(formatDuration(900)).toBe("900 ms");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
    expect(formatDuration(null)).toBe("-");
    expect(describeOverride({ kind: "context", op: "remove", key: "k" })).toBe(
      "remove context `k`",
    );
    expect(describeOverride({ kind: "state", op: "set", path: "/a", value: { b: 1 } })).toBe(
      'state `/a` = `{"b":1}`',
    );
    expect(describeOverride({ kind: "policy", policy: "p", config: { limit: 5 } })).toBe(
      'policy `p` config `{"limit":5}`',
    );
    expect(
      describeOverride({ kind: "tool_result", tool: "t", occurrence: 2, result: "x".repeat(100) }),
    ).toContain("…`");
  });
});
