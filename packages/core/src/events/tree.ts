import type { ShadowEvent } from "@shadow/schemas";
import { SPAN_OPENERS } from "@shadow/schemas";

export interface EventTreeNode {
  event: ShadowEvent;
  children: EventTreeNode[];
  depth: number;
  /** Duration of the span this node opens (from its closing child), if any. */
  spanDurationMs: number | null;
}

export function isSpanOpener(event: Pick<ShadowEvent, "eventType">): boolean {
  return event.eventType in SPAN_OPENERS;
}

/**
 * Build the execution hierarchy:
 *  - an event with `parentEventId` nests under that event (tool.response → tool.request);
 *  - a span opener nests under the opener of its `parentSpanId`;
 *  - any other event nests under the opener of its `spanId`.
 */
export function buildEventTree(events: readonly ShadowEvent[]): EventTreeNode[] {
  const byId = new Map<string, EventTreeNode>();
  const openerBySpan = new Map<string, EventTreeNode>();
  const roots: EventTreeNode[] = [];

  for (const event of events) {
    const node: EventTreeNode = { event, children: [], depth: 0, spanDurationMs: null };
    byId.set(event.id, node);
    if (isSpanOpener(event) && event.spanId) openerBySpan.set(event.spanId, node);
  }

  for (const event of events) {
    const node = byId.get(event.id) as EventTreeNode;
    let parent: EventTreeNode | undefined;
    if (event.parentEventId) parent = byId.get(event.parentEventId);
    if (!parent) {
      const spanKey = isSpanOpener(event) ? event.parentSpanId : event.spanId;
      if (spanKey) {
        const opener = openerBySpan.get(spanKey);
        if (opener && opener !== node) parent = opener;
      }
    }
    if (parent) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
      if (
        event.durationMs != null &&
        isSpanOpener(parent.event) &&
        parent.event.spanId === event.spanId
      ) {
        parent.spanDurationMs = Math.max(parent.spanDurationMs ?? 0, event.durationMs);
      }
    } else {
      roots.push(node);
    }
  }

  const fixDepth = (nodes: EventTreeNode[], depth: number) => {
    for (const n of nodes) {
      n.depth = depth;
      fixDepth(n.children, depth + 1);
    }
  };
  fixDepth(roots, 0);
  return roots;
}

export function flattenTree(nodes: readonly EventTreeNode[]): EventTreeNode[] {
  const out: EventTreeNode[] = [];
  const visit = (n: EventTreeNode) => {
    out.push(n);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}
