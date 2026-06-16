import { useEffect, useRef } from "react";
import type { Template } from "../../types";
import { TerminalIcon } from "../icons";

/** Step: the build is running — animated status + optional live terminal. */
export default function RunningStep({
  template,
  name,
  showTerminal,
  lines,
}: {
  template: Template;
  name: string;
  showTerminal: boolean;
  lines: { line: string; stream: string }[];
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest output in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="relative grid h-16 w-16 place-items-center">
        <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent/30" />
        <span className="absolute inset-2 animate-pulse-ring rounded-full bg-accent/20 [animation-delay:0.4s]" />
        <span className="relative grid h-11 w-11 animate-spin place-items-center rounded-full border-2 border-accent/30 border-t-accent text-xl [animation-duration:1.2s]">
          <span className="animate-none">{template.glyph}</span>
        </span>
      </div>
      <h3 className="mt-5 text-base font-semibold text-slate-100">
        Bootstrapping <span className="font-mono text-accent-soft">{name}</span>
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-slate-400">
        Running the {template.name} setup. This can take a moment while
        dependencies are fetched…
      </p>

      {showTerminal ? (
        <div className="mt-5 w-full text-left">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <TerminalIcon className="h-3.5 w-3.5" />
            Terminal
          </div>
          <div className="h-48 overflow-y-auto rounded-xl border border-surface-border bg-surface-base p-3 font-mono text-[11px] leading-relaxed">
            {lines.length === 0 ? (
              <span className="text-slate-600">Waiting for output…</span>
            ) : (
              lines.map((l, i) => (
                <div
                  key={i}
                  data-selectable="true"
                  className={`whitespace-pre-wrap break-words ${
                    l.stream === "stderr" ? "text-amber-300/90" : "text-slate-300"
                  }`}
                >
                  {l.line || " "}
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>
        </div>
      ) : (
        <div className="relative mt-6 h-1.5 w-64 overflow-hidden rounded-full bg-surface-card">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-shimmer rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />
        </div>
      )}
    </div>
  );
}
