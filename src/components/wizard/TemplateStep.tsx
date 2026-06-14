import type { Template } from "../../types";
import { TEMPLATES } from "../../lib/templates";
import { CheckIcon } from "../icons";

/** Framework-first step 1: pick a template to scaffold directly. */
export default function TemplateStep({
  selected,
  onSelect,
}: {
  selected: Template | null;
  onSelect: (t: Template) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
      {TEMPLATES.map((t) => {
        const active = selected?.id === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t)}
            className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
              active
                ? "border-accent/60 bg-surface-card shadow-glow"
                : "border-surface-border bg-surface-card hover:border-accent/30 hover:bg-surface-hover"
            }`}
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${t.accent} opacity-0 transition-opacity group-hover:opacity-100 ${
                active ? "opacity-100" : ""
              }`}
            />
            <div className="relative">
              <div className="flex items-center justify-between">
                <span className="text-2xl">{t.glyph}</span>
                {active && (
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-white">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-sm font-semibold text-slate-100">
                {t.name}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {t.description}
              </p>
              <p className="mt-3 text-[11px] text-slate-500">
                Requires{" "}
                <span className="font-mono text-slate-400">{t.requires}</span> on your PATH
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
