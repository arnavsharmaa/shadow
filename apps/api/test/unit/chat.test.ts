import { describe, expect, it } from "vitest";
import { escapeMrkdwn, formatChatMessage } from "../../src/notify/chat.js";
import type {
  AlertNotification,
  ReplayFailedNotification,
  TraceFinishedNotification,
} from "../../src/notify/webhook.js";

const finished: TraceFinishedNotification = {
  type: "trace.finished",
  sentAt: "2026-09-01T09:12:09.100Z",
  reason: "policy_violation",
  trace: {
    id: "trc_1",
    name: "refund <defective> headphones & more",
    projectSlug: "support-agent",
    agentSlug: "refund-agent",
    status: "failed",
    outcome: { kind: "policy_violation", label: "Policy violation" },
    startedAt: "2026-09-01T09:00:00.000Z",
    completedAt: "2026-09-01T09:01:05.500Z",
    tags: ["refund", "vip"],
  },
};

const alert: AlertNotification = {
  type: "alert.firing",
  sentAt: "2026-09-01T10:00:00.000Z",
  rule: {
    id: "alr_1",
    name: "refund failures",
    agent: "refund-agent",
    project: null,
    metric: "failure_rate",
    mode: "threshold",
    threshold: 0.2,
    windowMinutes: 60,
  },
  value: 0.5,
  baseline: null,
  traces: 12,
};

describe("chat formatting", () => {
  it("escapes Slack markup", () => {
    expect(escapeMrkdwn("a <b> & c")).toBe("a &lt;b&gt; &amp; c");
  });

  it("renders a finished trace with a link when the web URL is known", () => {
    const message = formatChatMessage(finished, "https://shadow.example.com/");
    expect(message.text).toBe(
      ":rotating_light: refund-agent: Policy violation - refund <defective> headphones & more (support-agent, 1 min 6 s)",
    );
    expect(message.blocks[0]).toEqual({
      type: "header",
      text: {
        type: "plain_text",
        text: ":rotating_light: refund-agent: Policy violation",
        emoji: true,
      },
    });
    const fields = (message.blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields).toEqual([
      "*Trace*\n<https://shadow.example.com/traces/trc_1|refund &lt;defective&gt; headphones &amp; more>",
      "*Outcome*\nPolicy violation",
      "*Project / agent*\nsupport-agent / refund-agent",
      "*Duration*\n1 min 6 s",
      "*Tags*\nrefund, vip",
    ]);
    expect((message.blocks[2] as { elements: { text: string }[] }).elements[0]?.text).toBe(
      "trc_1 · finished 2026-09-01T09:01:05.500Z · reason: policy_violation",
    );
  });

  it("falls back to bold names without a web URL and marks plain completions", () => {
    const completed: TraceFinishedNotification = {
      ...finished,
      reason: "all",
      trace: {
        ...finished.trace,
        status: "completed",
        outcome: null,
        tags: [],
        completedAt: "2026-09-01T09:00:00.250Z",
      },
    };
    const message = formatChatMessage(completed);
    expect(message.text).toContain(":white_check_mark: refund-agent: Completed");
    expect(message.text).toContain("250 ms");
    const fields = (message.blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields[0]).toBe("*Trace*\n*refund &lt;defective&gt; headphones &amp; more*");
    expect(fields).toHaveLength(4);
    const failed = formatChatMessage({
      ...completed,
      reason: "failed",
      trace: { ...completed.trace, status: "failed", completedAt: "2026-09-01T09:00:03.000Z" },
    });
    expect(failed.text).toContain(":x: refund-agent: Failed");
    expect(failed.text).toContain("3.0 s");
  });

  it("renders a failed replay with its error", () => {
    const failed: ReplayFailedNotification = {
      type: "replay.failed",
      sentAt: "2026-09-01T09:20:00.000Z",
      replay: {
        id: "rpl_1",
        mode: "deterministic",
        error: "replay could not reproduce the recorded prefix: expected tool <ping>",
        startedAt: "2026-09-01T09:19:59.000Z",
        completedAt: "2026-09-01T09:20:00.000Z",
      },
      trace: { id: "trc_1", name: "refund run", projectSlug: "support", agentSlug: "refund-agent" },
      branch: { id: "br_2", name: "limit 100" },
    };
    const message = formatChatMessage(failed, "https://shadow.example.com");
    expect(message.text).toBe(
      ":x: Replay failed: limit 100 - refund run (support / refund-agent, deterministic): replay could not reproduce the recorded prefix: expected tool <ping>",
    );
    const fields = (message.blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields).toEqual([
      "*Trace*\n<https://shadow.example.com/traces/trc_1|refund run>",
      "*Branch*\nlimit 100",
      "*Project / agent*\nsupport / refund-agent",
      "*Mode*\ndeterministic",
    ]);
    expect((message.blocks[2] as { text: { text: string } }).text.text).toBe(
      "```replay could not reproduce the recorded prefix: expected tool &lt;ping&gt;```",
    );
    expect((message.blocks[3] as { elements: { text: string }[] }).elements[0]?.text).toBe(
      "rpl_1 · 2026-09-01T09:20:00.000Z",
    );
    const unknown = formatChatMessage({
      ...failed,
      replay: { ...failed.replay, error: null, completedAt: null },
    });
    expect(unknown.text).toContain(": unknown error");
    expect(JSON.stringify(unknown.blocks)).toContain("rpl_1 · 2026-09-01T09:20:00.000Z");
  });

  it("renders threshold and baseline alerts", () => {
    const firing = formatChatMessage(alert, "https://shadow.example.com");
    expect(firing.text).toBe(
      ":red_circle: Alert firing: refund failures - failure rate 50.0% vs threshold 20.0% over 60 min (12 traces, agent refund-agent)",
    );
    const fields = (firing.blocks[1] as { fields: { text: string }[] }).fields.map((f) => f.text);
    expect(fields[0]).toBe("*Rule*\n<https://shadow.example.com/agents|refund failures>");
    expect(fields[3]).toBe("*Scope*\nagent refund-agent");

    const resolved = formatChatMessage({
      ...alert,
      type: "alert.resolved",
      rule: {
        ...alert.rule,
        agent: null,
        project: "support",
        metric: "p95_duration_ms",
        mode: "baseline",
        threshold: 2,
      },
      value: 4500,
      baseline: 1500,
      traces: 3,
    });
    expect(resolved.text).toBe(
      ":large_green_circle: Alert resolved: refund failures - p95 duration 4.5 s vs 2× baseline 1.5 s over 60 min (3 traces, project support)",
    );
    const cost = formatChatMessage({
      ...alert,
      rule: { ...alert.rule, agent: null, metric: "total_cost", threshold: 1 },
      value: 1.23456,
    });
    expect(cost.text).toContain("total cost $1.2346 vs threshold $1.0000");
    expect(cost.text).toContain("(12 traces)");
    const unknown = formatChatMessage({
      ...alert,
      rule: { ...alert.rule, metric: "custom" },
      value: null,
    });
    expect(unknown.text).toContain("custom - vs threshold 0.2");
  });
});
