import type { GitStatus, Project } from "../../types";
import StatusBadge from "../StatusBadge";
import { GitBranchIcon } from "../icons";

/** A compact, clickable project row for dashboard widgets. */
export default function ProjectRow({
  project,
  status,
  onOpen,
}: {
  project: Project;
  status: GitStatus | null | undefined;
  onOpen: (project: Project) => void;
}) {
  return (
    <button
      onClick={() => onOpen(project)}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-hover"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
        {project.name}
      </span>
      {status && (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-slate-500">
          <GitBranchIcon className="h-3 w-3" />
          {status.branch}
          {status.dirty && <span className="text-amber-300">●</span>}
          {status.ahead > 0 && <span className="text-accent-soft">↑{status.ahead}</span>}
        </span>
      )}
      <StatusBadge status={project.status} />
    </button>
  );
}
