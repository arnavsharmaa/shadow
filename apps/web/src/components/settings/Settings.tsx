"use client";

import { api } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import type { ApiKey, ApiKeyScope } from "@shadow/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

const SCOPES: { value: ApiKeyScope; label: string; help: string }[] = [
  {
    value: "ingest",
    label: "Ingest",
    help: "record traces: create, events, updates, artifacts, imports",
  },
  { value: "read", label: "Read", help: "read traces and statistics, change nothing" },
  { value: "admin", label: "Admin", help: "everything the API token can do, including keys" },
];

/** Settings: API keys. Health shows whether the API enforces authentication at all. */
export function Settings() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.apiKeys });
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiKeyScope>("ingest");
  const [project, setProject] = useState("");
  const [issued, setIssued] = useState<{ key: ApiKey; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  const create = useMutation({
    mutationFn: () =>
      api.createApiKey({
        name: name.trim(),
        scope,
        ...(scope !== "admin" && project ? { project } : {}),
      }),
    onSuccess: async (result) => {
      setIssued(result);
      setCopied(false);
      setName("");
      setProject("");
      setError(null);
      await refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api.revokeApiKey(key.id),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const copySecret = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const authOn = health.data?.features?.auth === true;

  return (
    <div className="flex h-full flex-col" data-testid="settings">
      <div className="flex items-center gap-3 border-b border-border bg-panel px-3 py-2 text-[12px]">
        <h1 className="text-[13px] font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12px]">
        <section className="max-w-4xl rounded border border-border bg-panel">
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-[12px] font-semibold">API keys</h2>
            {health.data && (
              <span className="text-[11px] text-fg-muted" data-testid="auth-state">
                {authOn
                  ? "The API requires a token or key on every request."
                  : "The API is open: SHADOW_API_TOKEN is not set, so keys are not checked yet."}
              </span>
            )}
          </header>
          <p className="px-3 pt-2 text-fg-muted">
            Keys let a deployment record or read traces without the admin token. An ingest or read
            key can be pinned to one project. Secrets are shown once; only a hash is stored.
          </p>
          <form
            className="flex flex-wrap items-end gap-2 px-3 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg-muted">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ci-ingest"
                maxLength={64}
                className="h-7 w-44 rounded border border-border bg-bg px-2"
                data-testid="key-name"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-fg-muted">Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as ApiKeyScope)}
                className="h-7 rounded border border-border bg-bg px-1"
                data-testid="key-scope"
              >
                {SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {scope !== "admin" && (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-fg-muted">Pin to project (optional)</span>
                <input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  list="key-projects"
                  placeholder="any project"
                  maxLength={64}
                  className="h-7 w-40 rounded border border-border bg-bg px-2"
                  data-testid="key-project"
                />
                <datalist id="key-projects">
                  {(facets.data?.projects ?? []).map((p) => (
                    <option key={p.slug} value={p.slug} />
                  ))}
                </datalist>
              </label>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim() || create.isPending}
              data-testid="create-key"
            >
              Create key
            </Button>
            <span className="text-[11px] text-fg-faint">
              {SCOPES.find((s) => s.value === scope)?.help}
            </span>
          </form>
          {issued && (
            <div
              className="mx-3 mb-3 rounded border border-ok/40 bg-ok-bg p-3"
              role="status"
              data-testid="issued-key"
            >
              <div className="font-semibold">
                Key {issued.key.name} created. Copy the secret now; it will not be shown again.
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="mono select-all break-all" data-testid="issued-secret">
                  {issued.secret}
                </code>
                <Button size="xs" onClick={copySecret} data-testid="copy-secret">
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setIssued(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p
              className="mx-3 mb-3 rounded border border-err/40 bg-err-bg p-2 text-err"
              role="alert"
            >
              {error}
            </p>
          )}
          {keys.isError ? (
            <ErrorState error={keys.error} retry={() => keys.refetch()} />
          ) : !keys.data ? (
            <div className="space-y-1 p-3" aria-busy="true">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : keys.data.items.length === 0 ? (
            <EmptyState title="No API keys yet">
              Create one above or with `shadow keys create`.
            </EmptyState>
          ) : (
            <table
              className="w-full border-collapse border-t border-border"
              data-testid="key-table"
            >
              <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-3 py-1">Name</th>
                  <th className="px-3 py-1">Scope</th>
                  <th className="px-3 py-1">Project</th>
                  <th className="px-3 py-1">Prefix</th>
                  <th className="px-3 py-1">Last used</th>
                  <th className="px-3 py-1">Created</th>
                  <th className="px-3 py-1" />
                </tr>
              </thead>
              <tbody>
                {keys.data.items.map((key) => (
                  <tr
                    key={key.id}
                    className="border-t border-border"
                    data-testid="key-row"
                    data-key-name={key.name}
                  >
                    <td className="px-3 py-1.5 font-medium">{key.name}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone={key.scope === "admin" ? "warn" : "muted"}>{key.scope}</Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      {key.project ?? <span className="text-fg-faint">any</span>}
                    </td>
                    <td className="mono px-3 py-1.5">{key.prefix}…</td>
                    <td className="px-3 py-1.5" title={key.lastUsedAt ?? ""}>
                      {key.lastUsedAt ? relativeTime(key.lastUsedAt) : "never"}
                    </td>
                    <td className="px-3 py-1.5">{dateTime(key.createdAt)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {key.revokedAt ? (
                        <Badge tone="err">revoked</Badge>
                      ) : (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => revoke.mutate(key)}
                          data-testid="revoke-key"
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
