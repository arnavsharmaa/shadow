"use client";

import { Dialog, Kbd } from "../ui/primitives";

export const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["j", "↓"], action: "Select the next event" },
  { keys: ["k", "↑"], action: "Select the previous event" },
  { keys: ["f"], action: "Fork from the selected event" },
  { keys: ["e"], action: "Jump to the first error" },
  { keys: ["p"], action: "Jump to the first policy denial or approval requirement" },
  { keys: ["b"], action: "Toggle the branch graph" },
  { keys: ["n"], action: "Write a note on the selected event" },
  { keys: ["Ctrl", "Enter"], action: "Save the note being written" },
  { keys: ["?"], action: "Show this list" },
  { keys: ["Esc"], action: "Close dialogs" },
];

/** Reference card for the trace detail's keyboard shortcuts. */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      testId="shortcuts-dialog"
      width="max-w-md"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-4 text-[12px]">
        {SHORTCUTS.map((s) => (
          <div key={s.action} className="contents">
            <dt className="flex items-center gap-1 whitespace-nowrap">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && (
                    <span className="text-fg-faint">{s.keys[0] === "Ctrl" ? "+" : "/"}</span>
                  )}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </dt>
            <dd className="text-fg-muted">{s.action}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-border px-4 py-2 text-[11px] text-fg-faint">
        Shortcuts are ignored while typing in a field.
      </p>
    </Dialog>
  );
}
