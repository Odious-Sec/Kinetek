import type { WizardMode } from "../../types";
import { CompassIcon, LayersIcon } from "../icons";

/** Step 0: choose the wizard path — build by goal, or by framework. */
export default function ModeStep({ onPick }: { onPick: (m: WizardMode) => void }) {
  const cards: {
    mode: WizardMode;
    title: string;
    blurb: string;
    icon: typeof LayersIcon;
    accent: string;
  }[] = [
    {
      mode: "goal",
      title: "Build by goal",
      blurb: "Pick a category like Finance or Fun and tell us what you want to make. We choose the tech and draft an AI starter.",
      icon: CompassIcon,
      accent: "from-accent/25 to-accent-soft/10",
    },
    {
      mode: "framework",
      title: "Build by framework",
      blurb: "Know the stack already? Pick a template (React, FastAPI, Rust…) and scaffold it directly.",
      icon: LayersIcon,
      accent: "from-sky-500/20 to-cyan-400/10",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <button
            key={c.mode}
            onClick={() => onPick(c.mode)}
            className="group relative overflow-hidden rounded-xl border border-surface-border bg-surface-card p-5 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow"
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${c.accent} opacity-0 transition-opacity group-hover:opacity-100`}
            />
            <div className="relative">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-raised text-accent-soft">
                <Icon className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-100">
                {c.title}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {c.blurb}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
