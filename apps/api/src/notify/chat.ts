import type { AlertNotification, TraceFinishedNotification } from "./webhook.js";

/**
 * Chat-ready rendering of webhook notifications: a Slack incoming-webhook message (`text` plus
 * Block Kit `blocks`), which Mattermost and Rocket.Chat incoming webhooks accept as well. The
 * plain `text` carries the whole message, so clients without block support lose nothing.
 */
export interface ChatMessage {
  text: string;
  blocks: ChatBlock[];
}

export type ChatBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: boolean } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "section"; fields: { type: "mrkdwn"; text: string }[] }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] };

/** Slack treats `&`, `<` and `>` as markup inside mrkdwn. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function link(url: string | undefined, label: string): string {
  return url ? `<${url}|${escapeMrkdwn(label)}>` : `*${escapeMrkdwn(label)}*`;
}

const METRIC_LABELS: Record<string, string> = {
  failure_rate: "failure rate",
  policy_violation_rate: "policy violation rate",
  tool_error_rate: "tool error rate",
  p95_duration_ms: "p95 duration",
  total_cost: "total cost",
  avg_cost: "average cost",
};

function metricValue(metric: string, value: number | null): string {
  if (value === null) return "-";
  if (metric.endsWith("_rate")) return `${(value * 100).toFixed(1)}%`;
  if (metric.endsWith("_ms")) return formatDuration(value);
  if (metric.includes("cost")) return `$${value.toFixed(4)}`;
  return String(value);
}

/** Where the web app shows the subject of a notification, when its base URL is known. */
function traceUrl(webUrl: string | undefined, traceId: string): string | undefined {
  return webUrl ? `${webUrl.replace(/\/$/, "")}/traces/${encodeURIComponent(traceId)}` : undefined;
}

function agentsUrl(webUrl: string | undefined): string | undefined {
  return webUrl ? `${webUrl.replace(/\/$/, "")}/agents` : undefined;
}

export function formatTraceFinished(
  notification: TraceFinishedNotification,
  webUrl?: string,
): ChatMessage {
  const { trace, reason } = notification;
  const outcome = trace.outcome?.label ?? (trace.status === "failed" ? "Failed" : "Completed");
  const icon =
    reason === "policy_violation"
      ? ":rotating_light:"
      : trace.status === "failed"
        ? ":x:"
        : ":white_check_mark:";
  const headline = `${icon} ${trace.agentSlug}: ${outcome}`;
  const duration = formatDuration(Date.parse(trace.completedAt) - Date.parse(trace.startedAt));
  const text = `${headline} - ${trace.name} (${trace.projectSlug}, ${duration})`;
  const fields = [
    `*Trace*\n${link(traceUrl(webUrl, trace.id), trace.name)}`,
    `*Outcome*\n${escapeMrkdwn(outcome)}`,
    `*Project / agent*\n${escapeMrkdwn(trace.projectSlug)} / ${escapeMrkdwn(trace.agentSlug)}`,
    `*Duration*\n${duration}`,
  ];
  if (trace.tags.length > 0) fields.push(`*Tags*\n${escapeMrkdwn(trace.tags.join(", "))}`);
  return {
    text,
    blocks: [
      { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
      { type: "section", fields: fields.map((f) => ({ type: "mrkdwn", text: f })) },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${escapeMrkdwn(trace.id)} · finished ${trace.completedAt} · reason: ${reason}`,
          },
        ],
      },
    ],
  };
}

export function formatAlert(notification: AlertNotification, webUrl?: string): ChatMessage {
  const { rule, value, baseline, traces } = notification;
  const firing = notification.type === "alert.firing";
  const metric = METRIC_LABELS[rule.metric] ?? rule.metric;
  const headline = `${firing ? ":red_circle: Alert firing" : ":large_green_circle: Alert resolved"}: ${rule.name}`;
  const comparison =
    rule.mode === "baseline"
      ? `${metricValue(rule.metric, value)} vs ${rule.threshold}× baseline ${metricValue(rule.metric, baseline)}`
      : `${metricValue(rule.metric, value)} vs threshold ${metricValue(rule.metric, rule.threshold)}`;
  const scope = [rule.project && `project ${rule.project}`, rule.agent && `agent ${rule.agent}`]
    .filter((s): s is string => Boolean(s))
    .join(", ");
  const text = `${headline} - ${metric} ${comparison} over ${rule.windowMinutes} min (${traces} traces${scope ? `, ${scope}` : ""})`;
  const fields = [
    `*Rule*\n${link(agentsUrl(webUrl), rule.name)}`,
    `*${escapeMrkdwn(metric)}*\n${escapeMrkdwn(comparison)}`,
    `*Window*\n${rule.windowMinutes} min, ${traces} traces`,
    `*Scope*\n${scope ? escapeMrkdwn(scope) : "all agents"}`,
  ];
  return {
    text,
    blocks: [
      { type: "header", text: { type: "plain_text", text: headline, emoji: true } },
      { type: "section", fields: fields.map((f) => ({ type: "mrkdwn", text: f })) },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${escapeMrkdwn(rule.id)} · ${notification.sentAt}` }],
      },
    ],
  };
}

export function formatChatMessage(
  notification: TraceFinishedNotification | AlertNotification,
  webUrl?: string,
): ChatMessage {
  return notification.type === "trace.finished"
    ? formatTraceFinished(notification, webUrl)
    : formatAlert(notification, webUrl);
}
