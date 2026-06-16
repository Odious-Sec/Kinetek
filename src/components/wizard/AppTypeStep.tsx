import type { AppKind } from "../../types";
import { APP_CATEGORIES, type AppCategory } from "../../lib/catalog";

/** Framework-path step 1: what kind of app — Web / Mobile / Desktop. */
export default function AppTypeStep({
  selected,
  onSelect,
}: {
  selected: AppKind | null;
  onSelect: (c: AppCategory) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-3">
      {APP_CATEGORIES.map((c) => {
        const active = selected === c.kind;
        return (
          <button
            key={c.kind}
            onClick={() => onSelect(c)}
            className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all hover:-translate-y-0.5 ${
              active
                ? "border-accent/60 bg-surface-card shadow-glow"
                : "border-surface-border bg-surface-card hover:border-accent/30 hover:bg-surface-hover"
            }`}
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${c.accent} opacity-0 transition-opacity group-hover:opacity-100 ${
                active ? "opacity-100" : ""
              }`}
            />
            <div className="relative">
              <span className="text-3xl">{c.glyph}</span>
              <h3 className="mt-3 text-sm font-semibold text-slate-100">{c.name}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{c.description}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
