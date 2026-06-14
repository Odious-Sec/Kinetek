import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearLog, getSnapshot, subscribe } from "../lib/logStore";
import { AlertIcon, ChevronDownIcon, TerminalIcon, TrashIcon } from "./icons";

/**
 * A self-contained, real-time log console. Drop one `<LogConsole />` into the
 * app — it manages its own open/closed state and subscribes to the log store,
 * so new entries (errors + activity) stream in live.
 */
export default function LogConsole() {
  const entries = useSyncExternalStore(subscribe, getSnapshot);
  const [open, setOpen] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const errorCount = entries.filter((e) => e.level === "error").length;

  // Auto-scroll to the newest entry while the console is open.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [entries, open]);

  return (
    <>
      {/* Toggle button (bottom-left, clear of the bottom-right toasts) */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="no-drag fixed bottom-5 left-5 z-[55] inline-flex items-center gap-2 rounded-xl border border-surface-border bg-surface-raised px-3 py-2 text-xs font-medium text-slate-300 shadow-card transition-colors hover:bg-surface-hover"
        >
          <TerminalIcon className="h-4 w-4" />
          Logs
          {errorCount > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-rose-500/20 px-1 text-[10px] font-semibold text-rose-300">
              {errorCount}
            </span>
          )}
        </button>
      )}

      {/* Drawer */}
      {open && (
        <div className="fixed bottom-5 left-5 z-[55] flex h-80 w-[min(34rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface-raised/95 shadow-glow backdrop-blur animate-fade-in">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-surface-border px-3 py-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <TerminalIcon className="h-4 w-4 text-accent-soft" />
              Activity log
              <span className="text-slate-500">
                · {entries.length} entr{entries.length === 1 ? "y" : "ies"}
                {errorCount > 0 && (
                  <span className="text-rose-300"> · {errorCount} error{errorCount === 1 ? "" : "s"}</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => clearLog()}
                disabled={entries.length === 0}
                title="Clear the log"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200 disabled:opacity-30"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setOpen(false)}
                title="Hide"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
              >
                <ChevronDownIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Entries */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed">
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-slate-600">
                <TerminalIcon className="h-5 w-5" />
                <span>No activity yet.</span>
              </div>
            ) : (
              entries.map((e) => (
                <div
                  key={e.id}
                  data-selectable="true"
                  className={`flex gap-2 rounded-md px-1.5 py-1 ${
                    e.level === "error" ? "bg-rose-500/5" : ""
                  }`}
                >
                  <span className="shrink-0 text-slate-600">
                    {e.ts.slice(11, 19)}
                  </span>
                  <span
                    className={`shrink-0 ${
                      e.level === "error" ? "text-rose-300" : "text-slate-500"
                    }`}
                  >
                    {e.level === "error" ? (
                      <AlertIcon className="inline h-3 w-3" />
                    ) : (
                      "·"
                    )}{" "}
                    [{e.context}]
                  </span>
                  <span
                    className={`whitespace-pre-wrap break-words ${
                      e.level === "error" ? "text-rose-200/90" : "text-slate-300"
                    }`}
                  >
                    {e.message}
                  </span>
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>

          {/* Footer hint */}
          <div className="shrink-0 border-t border-surface-border px-3 py-1.5 text-[10px] text-slate-600">
            Errors are also saved to{" "}
            <span className="font-mono text-slate-500">kinetek-errors.log</span>.
          </div>
        </div>
      )}
    </>
  );
}
