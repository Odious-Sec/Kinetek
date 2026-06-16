import type { Project } from "../../types";
import type { StatusMap } from "../../hooks/useProjectStatuses";
import Widget from "./Widget";
import { LayersIcon } from "../icons";

interface Props {
  projects: Project[];
  statuses: StatusMap;
}

/** At-a-glance counts: total projects, live, in-dev, and uncommitted work. */
export default function StatsWidget({ projects, statuses }: Props) {
  const real = projects.filter((p) => !p.id.startsWith("sample-"));
  const live = real.filter((p) => p.status === "Live").length;
  const inDev = real.filter((p) => p.status === "In Development").length;
  const dirty = real.filter((p) => statuses[p.id]?.dirty).length;

  const tiles = [
    { label: "Projects", value: real.length, tone: "text-slate-100" },
    { label: "Live", value: live, tone: "text-emerald-300" },
    { label: "In dev", value: inDev, tone: "text-accent-soft" },
    { label: "Uncommitted", value: dirty, tone: dirty ? "text-amber-300" : "text-slate-400" },
  ];

  return (
    <Widget title="At a glance" icon={<LayersIcon className="h-4 w-4" />}>
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-xl border border-surface-border bg-surface-base p-3"
          >
            <div className={`text-2xl font-semibold tabular-nums ${t.tone}`}>
              {t.value}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">{t.label}</div>
          </div>
        ))}
      </div>
    </Widget>
  );
}
