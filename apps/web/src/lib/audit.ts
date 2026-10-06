import type { AuditEntry } from "@shadow/schemas";

const LABELS: Record<string, string> = {
  "trace.updated": "updated the trace",
  "trace.deleted": "deleted the trace",
  "trace.imported": "imported the trace",
  "traces.pruned": "pruned traces",
  "fork.created": "forked",
  "matrix.run": "ran a scenario matrix",
  "replay.run": "replayed",
  "branch.updated": "renamed or edited a branch",
  "branch.deleted": "deleted a branch",
  "comparison.created": "compared branches",
  "artifact.created": "attached an artifact",
  "batch.run": "ran a batch counterfactual",
  "batch.queued": "queued a batch job",
  "batch.cancelled": "cancelled a batch job",
  "view.saved": "saved a shared view",
  "view.deleted": "deleted a shared view",
  "share.created": "created a share link",
  "share.revoked": "revoked a share link",
  "alert.created": "created an alert rule",
  "alert.updated": "changed an alert rule",
  "alert.deleted": "deleted an alert rule",
  "collection.created": "created a collection",
  "collection.updated": "changed a collection",
  "collection.deleted": "deleted a collection",
  "collection.traces_added": "added traces to a collection",
  "collection.traces_removed": "removed a trace from a collection",
  "key.created": "created an API key",
  "key.revoked": "revoked an API key",
};

/** One line saying what an audit entry did, from its action and details. */
export function describeAudit(entry: AuditEntry): string {
  const d = entry.details;
  const name = typeof d.name === "string" ? d.name : null;
  switch (entry.action) {
    case "fork.created":
      return `forked ${name ?? entry.targetId}`;
    case "replay.run":
      return `replayed ${entry.targetId} (${String(d.status ?? "?")})`;
    case "branch.deleted":
      return `deleted branch ${name ?? entry.targetId}`;
    case "branch.updated": {
      const changes = d.changes as { name?: unknown } | undefined;
      return typeof changes?.name === "string"
        ? `renamed ${entry.targetId} to ${changes.name}`
        : `edited branch ${entry.targetId}`;
    }
    case "artifact.created":
      return `attached ${String(d.kind ?? "an artifact")}${name ? ` "${name}"` : ""}`;
    case "traces.pruned":
      return `pruned ${String(d.deleted ?? "?")} trace(s) started before ${String(d.before ?? "?")}`;
    case "trace.deleted":
      return `deleted trace ${name ?? entry.targetId}`;
    case "key.created":
      return `created API key ${name ?? entry.targetId} (${String(d.scope ?? "?")})`;
    case "key.revoked":
      return `revoked API key ${name ?? entry.targetId}`;
    case "collection.traces_added": {
      const ids = Array.isArray(d.traceIds) ? d.traceIds.length : 0;
      return `added ${ids} trace(s) to collection ${name ?? entry.targetId}`;
    }
    default: {
      const label = LABELS[entry.action] ?? entry.action;
      return name && !label.includes(name) ? `${label}: ${name}` : label;
    }
  }
}
