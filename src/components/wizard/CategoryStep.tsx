import type { Category } from "../../types";
import { CATEGORIES } from "../../lib/categories";

/** Goal-first step 1: pick a top-level category (Finance, Fun, …). */
export default function CategoryStep({
  selected,
  onSelect,
}: {
  selected: Category | null;
  onSelect: (c: Category) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
      {CATEGORIES.map((c) => {
        const active = selected?.id === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c)}
            className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
              active
                ? "border-accent/60 bg-surface-card shadow-glow"
                : "border-surface-border bg-surface-card hover:border-accent/30 hover:bg-surface-hover"
            }`}
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${c.accent} opacity-0 transition-opacity group-hover:opacity-100`}
            />
            <div className="relative flex items-start gap-3">
              <span className="text-2xl">{c.glyph}</span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-100">{c.name}</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                  {c.description}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {c.purposes.length} ideas
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
