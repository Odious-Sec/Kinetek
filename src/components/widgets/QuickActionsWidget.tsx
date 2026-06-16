import Widget from "./Widget";
import {
  CompassIcon,
  GithubIcon,
  PlusIcon,
  SearchIcon,
  SparkIcon,
} from "../icons";

interface Props {
  onNewProject: () => void;
  onScanFolder: () => void;
  onOpenGithub: () => void;
  onOpenExplorer: () => void;
}

/** Top-of-dashboard quick actions: the things you reach for most. */
export default function QuickActionsWidget({
  onNewProject,
  onScanFolder,
  onOpenGithub,
  onOpenExplorer,
}: Props) {
  const actions = [
    { label: "New project", icon: <PlusIcon className="h-5 w-5" />, onClick: onNewProject, primary: true },
    { label: "Scan a folder", icon: <SearchIcon className="h-5 w-5" />, onClick: onScanFolder },
    { label: "Browse GitHub", icon: <GithubIcon className="h-5 w-5" />, onClick: onOpenGithub },
    { label: "File explorer", icon: <CompassIcon className="h-5 w-5" />, onClick: onOpenExplorer },
  ];
  return (
    <Widget title="Quick actions" icon={<SparkIcon className="h-4 w-4" />}>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            className={`flex flex-col items-center gap-2 rounded-xl border p-4 text-center text-xs font-medium transition-all hover:-translate-y-0.5 ${
              a.primary
                ? "border-accent/40 bg-accent/15 text-accent-soft hover:shadow-glow"
                : "border-surface-border bg-surface-base text-slate-300 hover:border-accent/30 hover:bg-surface-hover"
            }`}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
    </Widget>
  );
}
