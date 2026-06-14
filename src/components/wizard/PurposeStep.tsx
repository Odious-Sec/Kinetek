import type { Category, Purpose } from "../../types";
import { getTemplate } from "../../lib/templates";
import { ArrowRightIcon } from "../icons";

/** Goal-first step 2: pick a concrete thing-to-build within the category. */
export default function PurposeStep({
  category,
  onSelect,
}: {
  category: Category;
  onSelect: (p: Purpose) => void;
}) {
  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2 pb-1 text-sm text-slate-400">
        <span className="text-lg">{category.glyph}</span>
        <span>What kind of {category.name.toLowerCase()} project?</span>
      </div>
      {category.purposes.map((p) => {
        const t = getTemplate(p.templateId);
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className="group flex w-full items-center gap-3 rounded-xl border border-surface-border bg-surface-card p-3.5 text-left transition-all hover:border-accent/40 hover:bg-surface-hover"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-100">{p.name}</span>
                {t && (
                  <span className="rounded-md border border-surface-border bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                    {t.glyph} {t.name}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">{p.description}</p>
            </div>
            <ArrowRightIcon className="h-4 w-4 shrink-0 text-slate-600 transition-colors group-hover:text-accent-soft" />
          </button>
        );
      })}
    </div>
  );
}
