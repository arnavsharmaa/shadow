import { createHmac } from "node:crypto";
import type { Outcome } from "@shadow/schemas";
import type { Logger } from "pino";
import type { ApiConfig } from "../config.js";

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

export interface WebhookOptions {
  config: Pick<ApiConfig, "SHADOW_WEBHOOK_URL" | "SHADOW_WEBHOOK_SECRET" | "SHADOW_WEBHOOK_EVENTS">;
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
 * Outgoing webhook for finished traces. Deliveries are fire-and-forget from the
 * ingestion path's point of view: failures are logged and retried, never
 * surfaced to the client that sent the events.
 */
export function createWebhook(options: WebhookOptions): Webhook {
  const url = options.config.SHADOW_WEBHOOK_URL;
  const secret = options.config.SHADOW_WEBHOOK_SECRET;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffMs = options.backoffMs ?? 250;
  const inflight = new Set<Promise<void>>();

  const deliver = async (notification: TraceFinishedNotification): Promise<void> => {
    if (!url) return;
    const body = JSON.stringify(notification);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "shadow-webhook",
      "x-shadow-event": notification.type,
      "x-shadow-delivery": `${notification.trace.id}:${notification.sentAt}`,
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
          options.logger.debug({ traceId: notification.trace.id, attempt }, "webhook delivered");
          return;
        }
        if (response.status < 500 && response.status !== 429) {
          options.logger.warn(
            { traceId: notification.trace.id, status: response.status },
            "webhook rejected; not retrying",
          );
          return;
        }
        options.logger.warn(
          { traceId: notification.trace.id, status: response.status, attempt },
          "webhook delivery failed",
        );
      } catch (error) {
        options.logger.warn(
          { traceId: notification.trace.id, attempt, err: error },
          "webhook delivery failed",
        );
      }
      if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }
    options.logger.error({ traceId: notification.trace.id, url }, "webhook delivery gave up");
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
    async settle() {
      await Promise.allSettled([...inflight]);
    },
  };
}

/** A webhook that does nothing; used when no URL is configured and in tests. */
export const noopWebhook: Webhook = {
  enabled: false,
  traceFinished: async () => undefined,
  settle: async () => undefined,
};
