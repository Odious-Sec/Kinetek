import type { ProjectStatus } from "../types";

const STYLES: Record<ProjectStatus, { dot: string; text: string; ring: string }> = {
  Live: {
    dot: "bg-emerald-400",
    text: "text-emerald-300",
    ring: "bg-emerald-400/15 ring-emerald-400/30",
  },
  "In Development": {
    dot: "bg-amber-400",
    text: "text-amber-300",
    ring: "bg-amber-400/15 ring-amber-400/30",
  },
  "On Hold": {
    dot: "bg-slate-400",
    text: "text-slate-300",
    ring: "bg-slate-400/10 ring-slate-400/20",
  },
};

export default function StatusBadge({ status }: { status: ProjectStatus }) {
  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${s.ring} ${s.text}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {status === "Live" && (
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${s.dot} animate-pulse-ring`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${s.dot}`} />
      </span>
      {status}
    </span>
  );
}
