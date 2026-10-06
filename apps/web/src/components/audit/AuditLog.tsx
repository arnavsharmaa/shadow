"use client";

import { api } from "@/lib/api";
import { describeAudit } from "@/lib/audit";
import { dateTime, relativeTime } from "@/lib/format";
import { AUDIT_ACTIONS } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { JsonView } from "../json/JsonView";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

/** The whole audit log, newest first, with action and actor filters and cursor paging. */
export function AuditLog() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const action = params.get("action") ?? undefined;
  const actor = params.get("actor") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  const [actorInput, setActorInput] = useState(actor ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const log = useQuery({
    queryKey: ["audit-log", action, actor, cursor],
    queryFn: () => api.auditLog({ action, actor, cursor, limit: 50 }),
    refetchInterval: cursor ? false : 30_000,
  });

  const setParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    router.replace(next.size > 0 ? `${pathname}?${next.toString()}` : pathname);
  };

  return (
    <div className="flex h-full flex-col" data-testid="audit-log">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-2 text-[12px]">
        <h1 className="text-[13px] font-semibold">Audit log</h1>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Action
          <select
            value={action ?? ""}
            onChange={(e) => setParams({ action: e.target.value || undefined, cursor: undefined })}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="audit-action"
          >
            <option value="">All</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-center gap-1 text-[11px] text-fg-muted"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ actor: actorInput.trim() || undefined, cursor: undefined });
          }}
        >
          <label htmlFor="audit-actor">Actor</label>
          <input
            id="audit-actor"
            value={actorInput}
            onChange={(e) => setActorInput(e.target.value)}
            placeholder="anyone"
            className="h-7 w-36 rounded border border-border bg-bg px-2 text-[12px] text-fg placeholder:text-fg-faint"
            data-testid="audit-actor"
          />
          <Button type="submit" size="xs">
            Filter
          </Button>
        </form>
        <span className="ml-auto text-[11px] text-fg-faint">
          Actors are self-reported unless a request used an API key.
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {log.isError ? (
          <ErrorState error={log.error} retry={() => log.refetch()} />
        ) : !log.data ? (
          <div className="space-y-1 p-3" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : log.data.items.length === 0 ? (
          <EmptyState title="Nothing recorded">
            Forks, replays, deletions, imports, shares, keys and settings changes show up here.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="px-3 py-1.5">When</th>
                <th className="px-3 py-1.5">Actor</th>
                <th className="px-3 py-1.5">What</th>
                <th className="px-3 py-1.5">Trace</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {log.data.items.map((entry) => (
                <Fragment key={entry.id}>
                  <tr
                    className="border-t border-border"
                    data-testid="audit-row"
                    data-action={entry.action}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5" title={dateTime(entry.at)}>
                      {relativeTime(entry.at)}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge
                        tone={entry.actor.startsWith("key:") ? "info" : "muted"}
                        title={
                          entry.actor.startsWith("key:")
                            ? "authenticated with an API key"
                            : undefined
                        }
                      >
                        {entry.actor}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      {describeAudit(entry)}
                      <span className="mono ml-2 text-[10px] text-fg-faint">{entry.action}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      {entry.traceId ? (
                        <Link
                          href={`/traces/${encodeURIComponent(entry.traceId)}`}
                          className="mono text-accent hover:underline"
                        >
                          {entry.traceId}
                        </Link>
                      ) : (
                        <span className="text-fg-faint">–</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setOpen(open === entry.id ? null : entry.id)}
                        aria-expanded={open === entry.id}
                        data-testid="audit-details"
                      >
                        {open === entry.id ? "Hide" : "Details"}
                      </Button>
                    </td>
                  </tr>
                  {open === entry.id && (
                    <tr className="bg-bg-muted">
                      <td colSpan={5} className="px-3 py-2">
                        <JsonView
                          label="Details"
                          value={{
                            target: `${entry.targetType} ${entry.targetId}`,
                            requestId: entry.requestId,
                            ...entry.details,
                          }}
                          defaultExpandDepth={1}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {log.data && (log.data.nextCursor || cursor) && (
        <div className="flex items-center justify-end gap-2 border-t border-border bg-panel px-3 py-1.5 text-[11px]">
          <Button size="xs" disabled={!cursor} onClick={() => setParams({ cursor: undefined })}>
            Newest
          </Button>
          <Button
            size="xs"
            disabled={!log.data.nextCursor}
            onClick={() => setParams({ cursor: log.data?.nextCursor ?? undefined })}
            data-testid="audit-older"
          >
            Older
          </Button>
        </div>
      )}
    </div>
  );
}
