"use client";

import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { classNames } from "@/lib/format";

function readTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  const current = document.documentElement.getAttribute("data-theme");
  return current === "light" ? "light" : "dark";
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(readTheme);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("shadow-theme", next);
    } catch {
      // ignore storage errors
    }
  };
  return { theme, toggle };
}

export function TopNav() {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 15_000,
    retry: 0,
  });
  const healthy = health.data?.status === "ok";

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-panel px-3">
      <nav className="flex items-center gap-4" aria-label="Primary">
        <Link href="/" className="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
          <span className="inline-block h-3 w-3 rounded-sm bg-fg" aria-hidden="true" />
          Shadow
        </Link>
        <Link
          href="/"
          className={classNames(
            "text-[12px] text-fg-muted hover:text-fg",
            pathname === "/" && "text-fg font-medium",
          )}
        >
          Traces
        </Link>
        <a
          href={api.docsUrl()}
          target="_blank"
          rel="noreferrer"
          className="text-[12px] text-fg-muted hover:text-fg"
        >
          API docs
        </a>
      </nav>
      <div className="flex items-center gap-3 text-[11px] text-fg-muted">
        <span
          className="flex items-center gap-1.5"
          title={
            health.data
              ? `${health.data.database.kind} · ${health.data.database.location}`
              : "API unreachable"
          }
        >
          <span
            className={classNames(
              "inline-block h-2 w-2 rounded-full",
              healthy ? "bg-ok" : health.isLoading ? "bg-fg-faint" : "bg-err",
            )}
            aria-hidden="true"
          />
          <span aria-live="polite">
            {healthy
              ? `API · ${health.data?.database.kind}`
              : health.isLoading
                ? "API"
                : "API offline"}
          </span>
        </span>
        <button
          type="button"
          onClick={toggle}
          className="rounded border border-border px-2 py-0.5 hover:bg-hover"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          suppressHydrationWarning
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </div>
    </header>
  );
}
