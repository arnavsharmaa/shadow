"use client";

import { dateTime, duration, money } from "@/lib/format";
import type { JsonValue, ShadowEvent } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { JsonView } from "../json/JsonView";
import { Badge, Button, KeyValue, eventTone } from "../ui/primitives";

interface Props {
  event: ShadowEvent;
  events: ShadowEvent[];
  eventsById: Map<string, ShadowEvent>;
  onSelect: (id: string) => void;
}

export function EventDetail({ event, events, eventsById, onSelect }: Props) {
  const artifacts = useQuery({
    queryKey: ["artifacts", event.traceId, event.id],
    queryFn: () => api.artifacts(event.traceId, { eventId: event.id }),
  });
  const [copied, setCopied] = useState(false);
  const copyPermalink = async () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("branch", event.branchId);
      url.searchParams.set("event", event.id);
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const parent = event.parentEventId ? eventsById.get(event.parentEventId) : undefined;
  const children = events.filter((e) => e.parentEventId === event.id);
  const spanOpener = event.spanId
    ? events.find(
        (e) =>
          e.spanId === event.spanId &&
          e.id !== event.id &&
          (e.eventType.endsWith(".request") || e.eventType === "agent.started"),
      )
    : undefined;
  const shadow = event.metadata.shadow as Record<string, JsonValue> | undefined;
  const { shadow: _shadow, ...userMetadata } = event.metadata;

  return (
    <div className="space-y-3 p-3" data-testid="event-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={eventTone(event.eventType, event.severity)}>{event.eventType}</Badge>
        <span className="text-[13px] font-semibold" data-testid="event-name">
          {event.name}
        </span>
        {event.severity !== "info" && (
          <Badge
            tone={event.severity === "error" ? "err" : event.severity === "warn" ? "warn" : "muted"}
          >
            {event.severity}
          </Badge>
        )}
        {event.tags.map((t) => (
          <Badge key={t} tone="muted">
            {t}
          </Badge>
        ))}
        {shadow?.overrideApplied === true && <Badge tone="info">result from override</Badge>}
        {shadow?.origin === "override" && <Badge tone="info">override</Badge>}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={copyPermalink}
          aria-label="Copy a permalink to this event"
          data-testid="copy-permalink"
        >
          {copied ? "Link copied" : "Copy link"}
        </Button>
      </div>
      <dl>
        <KeyValue label="Event id" mono>
          {event.id}
        </KeyValue>
        <KeyValue label="Sequence" mono>
          {event.sequence}
        </KeyValue>
        <KeyValue label="Timestamp" mono>
          {dateTime(event.timestamp)} <span className="text-fg-faint">({event.timestamp})</span>
        </KeyValue>
        <KeyValue label="Duration">
          {event.durationMs != null ? (
            duration(event.durationMs)
          ) : (
            <span className="text-fg-faint">–</span>
          )}
        </KeyValue>
        <KeyValue label="Source">{event.source}</KeyValue>
        {event.tokenUsage && (
          <KeyValue label="Tokens">
            {event.tokenUsage.totalTokens}{" "}
            <span className="text-fg-faint">
              ({event.tokenUsage.inputTokens} in / {event.tokenUsage.outputTokens} out)
            </span>
          </KeyValue>
        )}
        {event.estimatedCost && (
          <KeyValue label="Est. cost">
            {money(event.estimatedCost.amount, event.estimatedCost.currency)}
            {event.estimatedCost.model && (
              <span className="text-fg-faint">
                {" "}
                · {event.estimatedCost.provider}/{event.estimatedCost.model}
              </span>
            )}
            {event.estimatedCost.pricingVersion && (
              <span className="text-fg-faint"> · pricing {event.estimatedCost.pricingVersion}</span>
            )}
          </KeyValue>
        )}
        {event.stateVersion != null && (
          <KeyValue label="State version">{event.stateVersion}</KeyValue>
        )}
        {event.correlationId && (
          <KeyValue label="Correlation" mono>
            {event.correlationId}
          </KeyValue>
        )}
        <KeyValue label="Branch" mono>
          {event.branchId}
        </KeyValue>
        <KeyValue label="Span" mono>
          {event.spanId ?? "–"}
          {spanOpener && spanOpener.id !== event.id && (
            <>
              {" "}
              <LinkButton onClick={() => onSelect(spanOpener.id)}>
                opened by #{spanOpener.sequence} {spanOpener.name}
              </LinkButton>
            </>
          )}
        </KeyValue>
        <KeyValue label="Parent">
          {parent ? (
            <LinkButton onClick={() => onSelect(parent.id)}>
              #{parent.sequence} {parent.eventType} {parent.name}
            </LinkButton>
          ) : (
            <span className="text-fg-faint">none</span>
          )}
        </KeyValue>
        <KeyValue label="Children">
          {children.length === 0 ? (
            <span className="text-fg-faint">none</span>
          ) : (
            <span className="flex flex-wrap gap-2">
              {children.map((c) => (
                <LinkButton key={c.id} onClick={() => onSelect(c.id)}>
                  #{c.sequence} {c.eventType}
                </LinkButton>
              ))}
            </span>
          )}
        </KeyValue>
      </dl>
      <JsonView label="Input" value={event.input} testId="event-input" />
      <JsonView label="Output" value={event.output} testId="event-output" />
      {Object.keys(userMetadata).length > 0 && (
        <JsonView label="Metadata" value={userMetadata} defaultExpandDepth={1} />
      )}
      {shadow && <JsonView label="Shadow metadata" value={shadow} defaultExpandDepth={1} />}
      {artifacts.data && artifacts.data.items.length > 0 && (
        <section data-testid="event-artifacts">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Artifacts ({artifacts.data.items.length})
          </h3>
          <div className="space-y-2">
            {artifacts.data.items.map((artifact) => (
              <JsonView
                key={artifact.id}
                label={`${artifact.kind} · ${artifact.name} · ${artifact.contentType}`}
                value={artifact.content}
                defaultExpandDepth={2}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-accent hover:underline">
      {children}
    </button>
  );
}
