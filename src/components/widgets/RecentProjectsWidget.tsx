import type { Project } from "../../types";
import type { StatusMap } from "../../hooks/useProjectStatuses";
import Widget from "./Widget";
import ProjectRow from "./ProjectRow";
import { ClockIcon } from "../icons";

interface Props {
  projects: Project[];
  statuses: StatusMap;
  onOpen: (project: Project) => void;
  onViewAll: () => void;
}

/** The most recently added projects (App keeps newest first). */
export default function RecentProjectsWidget({
  projects,
  statuses,
  onOpen,
  onViewAll,
}: Props) {
  const recent = projects.slice(0, 6);
  return (
    <Widget
      title="Recent projects"
      icon={<ClockIcon className="h-4 w-4" />}
      action={
        <button
          onClick={onViewAll}
          className="text-[11px] text-slate-500 transition-colors hover:text-accent-soft"
        >
          View all
        </button>
      }
    >
      {recent.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-slate-600">
          No projects yet — create or scan one to get started.
        </p>
      ) : (
        <div className="space-y-0.5">
          {recent.map((p) => (
            <ProjectRow key={p.id} project={p} status={statuses[p.id]} onOpen={onOpen} />
          ))}
        </div>
      )}
    </Widget>
  );
}
