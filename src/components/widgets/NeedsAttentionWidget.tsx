import type { Project } from "../../types";
import type { StatusMap } from "../../hooks/useProjectStatuses";
import Widget from "./Widget";
import ProjectRow from "./ProjectRow";
import { AlertIcon, CheckCircleIcon } from "../icons";

interface Props {
  projects: Project[];
  statuses: StatusMap;
  loading: boolean;
  onOpen: (project: Project) => void;
}

/** Projects with uncommitted changes or unpushed commits — what to act on. */
export default function NeedsAttentionWidget({
  projects,
  statuses,
  loading,
  onOpen,
}: Props) {
  const flagged = projects.filter((p) => {
    const s = statuses[p.id];
    return s && (s.dirty || s.ahead > 0);
  });

  return (
    <Widget title="Needs attention" icon={<AlertIcon className="h-4 w-4" />}>
      {loading && flagged.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-slate-600">Checking git status…</p>
      ) : flagged.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <CheckCircleIcon className="h-6 w-6 text-emerald-300/80" />
          <p className="text-xs text-slate-500">Everything's committed and pushed.</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {flagged.map((p) => (
            <ProjectRow key={p.id} project={p} status={statuses[p.id]} onOpen={onOpen} />
          ))}
        </div>
      )}
    </Widget>
  );
}
