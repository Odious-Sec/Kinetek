import type { Platform } from "../../types";
import type { AppCategory } from "../../lib/catalog";

/** Framework-path step 2 (mobile/desktop only): pick a target platform. */
export default function PlatformStep({
  category,
  selected,
  onSelect,
}: {
  category: AppCategory;
  selected: Platform | null;
  onSelect: (p: Platform) => void;
}) {
  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center gap-2 pb-1 text-sm text-slate-400">
        <span className="text-lg">{category.glyph}</span>
        <span>Which platform should this {category.name.toLowerCase()} target?</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(category.platforms ?? []).map((p) => {
          const active = selected === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={`group flex flex-col items-center gap-2 rounded-xl border p-5 text-center transition-all hover:-translate-y-0.5 ${
                active
                  ? "border-accent/60 bg-surface-card shadow-glow"
                  : "border-surface-border bg-surface-card hover:border-accent/30 hover:bg-surface-hover"
              }`}
            >
              <span className="text-3xl">{p.glyph}</span>
              <span className="text-sm font-medium text-slate-100">{p.name}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500">
        Cross-platform frameworks (Flutter, .NET MAUI, Expo, Tauri…) appear under
        any specific platform too.
      </p>
    </div>
  );
}
