"use client";

import { classNames } from "@/lib/format";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Tone = "default" | "ok" | "warn" | "err" | "info" | "purple" | "teal" | "muted";

const toneClasses: Record<Tone, string> = {
  default: "bg-muted text-fg border-border",
  ok: "bg-ok-bg text-ok border-ok/30",
  warn: "bg-warn-bg text-warn border-warn/30",
  err: "bg-err-bg text-err border-err/30",
  info: "bg-info-bg text-info border-info/30",
  purple: "bg-purple-bg text-purple border-purple/30",
  teal: "bg-teal-bg text-teal border-teal/30",
  muted: "bg-transparent text-fg-muted border-border",
};

export function Badge({
  tone = "default",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={classNames(
        "inline-flex items-center rounded border px-1.5 py-[1px] text-[11px] font-medium leading-4 whitespace-nowrap",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function eventTone(eventType: string, severity?: string): Tone {
  if (severity === "error") return "err";
  if (eventType.startsWith("model.")) return "purple";
  if (eventType.startsWith("tool.")) return eventType === "tool.error" ? "err" : "teal";
  if (eventType.startsWith("policy."))
    return eventType === "policy.allowed"
      ? "ok"
      : eventType === "policy.evaluated"
        ? "info"
        : "warn";
  if (eventType.startsWith("state.") || eventType.startsWith("context.")) return "muted";
  if (eventType.startsWith("human.")) return "warn";
  if (eventType.startsWith("trace.") || eventType.startsWith("agent."))
    return eventType.endsWith("failed") ? "err" : "default";
  if (eventType.startsWith("replay.") || eventType === "fork.created") return "info";
  return "default";
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "err";
    case "running":
    case "recording":
    case "replaying":
      return "info";
    case "pending":
      return "warn";
    default:
      return "default";
  }
}

export function outcomeTone(kind: string | undefined | null): Tone {
  switch (kind) {
    case "policy_violation":
    case "error":
    case "incorrect_action":
      return "err";
    case "approval_pending":
    case "declined":
    case "denied":
      return "warn";
    case undefined:
    case null:
      return "muted";
    default:
      return "ok";
  }
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border-accent hover:opacity-90",
  secondary: "bg-panel text-fg border-border-strong hover:bg-hover",
  ghost: "bg-transparent text-fg-muted border-transparent hover:bg-hover hover:text-fg",
  danger: "bg-err-bg text-err border-err/40 hover:opacity-90",
};

export function Button({
  variant = "secondary",
  size = "sm",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "xs" | "sm" | "md";
}) {
  const sizeClass =
    size === "xs"
      ? "h-6 px-2 text-[11px]"
      : size === "md"
        ? "h-9 px-4 text-[13px]"
        : "h-7 px-2.5 text-[12px]";
  return (
    <button
      type="button"
      className={classNames(
        "inline-flex items-center gap-1.5 rounded border font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClass,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={classNames("flex min-h-0 flex-col border border-border bg-panel", className)}
    >
      {title !== undefined && (
        <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          <span className="truncate">{title}</span>
          {actions && (
            <span className="flex items-center gap-1 normal-case tracking-normal">{actions}</span>
          )}
        </header>
      )}
      <div className={classNames("min-h-0 flex-1 overflow-auto", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={classNames("animate-pulse rounded bg-muted", className)} aria-hidden="true" />
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-fg-muted"
      role="status"
    >
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {children && <p className="max-w-md text-[12px]">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  return (
    <div
      className="m-3 rounded border border-err/40 bg-err-bg p-3 text-[12px] text-err"
      role="alert"
    >
      <p className="font-semibold">Request failed{code ? ` (${code})` : ""}</p>
      <p className="mt-1 break-words text-fg">{message}</p>
      {retry && (
        <Button variant="secondary" size="xs" className="mt-2" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function KeyValue({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-2 py-0.5 text-[12px]">
      <dt className="w-28 shrink-0 text-fg-muted">{label}</dt>
      <dd className={classNames("min-w-0 flex-1 break-words", mono && "mono")}>{children}</dd>
    </div>
  );
}

/** Accessible modal built on the native <dialog>. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  width = "max-w-2xl",
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      data-testid={testId}
      aria-labelledby={`${testId ?? "dialog"}-title`}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={classNames(
        "m-auto w-[92vw] rounded border border-border-strong bg-panel p-0 text-fg shadow-2xl",
        width,
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 id={`${testId ?? "dialog"}-title`} className="text-[13px] font-semibold">
              {title}
            </h2>
            <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close dialog">
              Esc
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border-strong bg-muted px-1 font-mono text-[10px] text-fg-muted">
      {children}
    </kbd>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 text-[12px] text-fg-muted"
    >
      <span
        className="h-3 w-3 animate-spin rounded-full border-2 border-fg-faint border-t-accent"
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
