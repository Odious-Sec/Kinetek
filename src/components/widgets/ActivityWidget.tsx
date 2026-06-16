import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe } from "../../lib/logStore";
import Widget from "./Widget";
import { TerminalIcon } from "../icons";

/** Recent in-app activity + errors, newest first (from the live log store). */
export default function ActivityWidget() {
  const entries = useSyncExternalStore(subscribe, getSnapshot);
  const recent = entries.slice(-8).reverse();

  return (
    <Widget title="Recent activity" icon={<TerminalIcon className="h-4 w-4" />}>
      {recent.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-slate-600">
          Activity will appear here as you work.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {recent.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-xs">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  e.level === "error" ? "bg-rose-400" : "bg-emerald-400/70"
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="text-slate-300">{e.message}</span>
                <span className="ml-1.5 font-mono text-[10px] text-slate-600">
                  {e.context}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-slate-600">
                {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
