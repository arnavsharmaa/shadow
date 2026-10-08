import { createHmac } from "node:crypto";
import type { Outcome } from "@shadow/schemas";
import type { Logger } from "pino";
import type { ApiConfig } from "../config.js";
import { formatChatMessage } from "./chat.js";

export interface TraceFinishedNotification {
  type: "trace.finished";
  sentAt: string;
  trace: {
    id: string;
    name: string;
    projectSlug: string;
    agentSlug: string;
    status: "completed" | "failed";
    outcome: Outcome | null;
    startedAt: string;
    completedAt: string;
    tags: string[];
  };
  /** Why this trace matched the configured filter. */
  reason: "failed" | "policy_violation" | "all";
}

/** An alert rule changed state (`alert.firing` when it crosses its threshold, `alert.resolved` after). */
export interface AlertNotification {
  type: "alert.firing" | "alert.resolved";
  sentAt: string;
  rule: {
    id: string;
    name: string;
    agent: string | null;
    project: string | null;
    metric: string;
    mode: "threshold" | "baseline";
    /** A value in threshold mode, a multiplier of `baseline` in baseline mode. */
    threshold: number;
    windowMinutes: number;
  };
  value: number | null;
  /** The baseline the value was compared against (baseline mode), otherwise `null`. */
  baseline: number | null;
  traces: number;
}

type Notification = TraceFinishedNotification | AlertNotification;

export interface WebhookOptions {
  config: Pick<
    ApiConfig,
    "SHADOW_WEBHOOK_URL" | "SHADOW_WEBHOOK_SECRET" | "SHADOW_WEBHOOK_EVENTS"
  > &
    Partial<Pick<ApiConfig, "SHADOW_WEBHOOK_FORMAT" | "SHADOW_WEB_URL">>;
  logger: Logger;
  fetch?: typeof fetch;
  /** Attempts per notification (default 3, exponential backoff from 250 ms). */
  maxAttempts?: number;
  backoffMs?: number;
}

export interface Webhook {
  enabled: boolean;
  /** Decide and send; resolves after delivery (or after retries fail). Never throws. */
  traceFinished(
    input: Omit<TraceFinishedNotification, "type" | "sentAt" | "reason">,
  ): Promise<void>;
  /** Send an alert state change; not subject to the SHADOW_WEBHOOK_EVENTS filter. Never throws. */
  alert(input: Omit<AlertNotification, "sentAt">): Promise<void>;
  /** Outstanding deliveries, so shutdown can wait for them. */
  settle(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Which notification a finished trace qualifies for under the configured event filter. */
export function classify(
  events: ApiConfig["SHADOW_WEBHOOK_EVENTS"],
  trace: { status: "completed" | "failed"; outcome: Outcome | null },
): TraceFinishedNotification["reason"] | null {
  if (events === "all") return "all";
  if (trace.outcome?.kind === "policy_violation") return "policy_violation";
  if (events === "failures" && trace.status === "failed") return "failed";
  return null;
}

/** Sign a body with HMAC-SHA256 as `sha256=<hex>` (GitHub-style). */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Outgoing webhook for finished traces and alerts. Deliveries are fire-and-forget from the
 * ingestion path's point of view: failures are logged and retried, never surfaced to the
 * client that sent the events. The body is Shadow's own JSON notification, or with
 * `SHADOW_WEBHOOK_FORMAT=slack` a chat message for a Slack-compatible incoming webhook; the
 * `x-shadow-*` headers and the signature cover whichever body is sent.
 */
export function createWebhook(options: WebhookOptions): Webhook {
  const url = options.config.SHADOW_WEBHOOK_URL;
  const secret = options.config.SHADOW_WEBHOOK_SECRET;
  const format = options.config.SHADOW_WEBHOOK_FORMAT ?? "json";
  const webUrl = options.config.SHADOW_WEB_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffMs = options.backoffMs ?? 250;
  const inflight = new Set<Promise<void>>();

  const deliver = async (notification: Notification): Promise<void> => {
    if (!url) return;
    const body = JSON.stringify(
      format === "slack" ? formatChatMessage(notification, webUrl) : notification,
    );
    const subject =
      notification.type === "trace.finished" ? notification.trace.id : notification.rule.id;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "shadow-webhook",
      "x-shadow-event": notification.type,
      "x-shadow-delivery": `${subject}:${notification.sentAt}`,
    };
    if (secret) headers["x-shadow-signature-256"] = sign(secret, body);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          options.logger.debug({ subject, attempt }, "webhook delivered");
          return;
        }
        if (response.status < 500 && response.status !== 429) {
          options.logger.warn(
            { subject, status: response.status },
            "webhook rejected; not retrying",
          );
          return;
        }
        options.logger.warn(
          { subject, status: response.status, attempt },
          "webhook delivery failed",
        );
      } catch (error) {
        options.logger.warn({ subject, attempt, err: error }, "webhook delivery failed");
      }
      if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }
    options.logger.error({ subject, url }, "webhook delivery gave up");
  };

  return {
    enabled: url !== undefined,
    async traceFinished(input) {
      if (!url) return;
      const reason = classify(options.config.SHADOW_WEBHOOK_EVENTS, input.trace);
      if (!reason) return;
      const notification: TraceFinishedNotification = {
        type: "trace.finished",
        sentAt: new Date().toISOString(),
        trace: input.trace,
        reason,
      };
      const task = deliver(notification).finally(() => inflight.delete(task));
      inflight.add(task);
      await task;
    },
    async alert(input) {
      if (!url) return;
      const task = deliver({ ...input, sentAt: new Date().toISOString() }).finally(() =>
        inflight.delete(task),
      );
      inflight.add(task);
      await task;
    },
    async settle() {
      await Promise.allSettled([...inflight]);
    },
  };
}

/** A webhook that does nothing; used when no URL is configured and in tests. */
export const noopWebhook: Webhook = {
  enabled: false,
  traceFinished: async () => undefined,
  alert: async () => undefined,
  settle: async () => undefined,
};
