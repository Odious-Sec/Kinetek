import type { ReactNode } from "react";
import type { Project } from "../types";
import { useProjectStatuses } from "../hooks/useProjectStatuses";
import QuickActionsWidget from "./widgets/QuickActionsWidget";
import StatsWidget from "./widgets/StatsWidget";
import RecentProjectsWidget from "./widgets/RecentProjectsWidget";
import NeedsAttentionWidget from "./widgets/NeedsAttentionWidget";
import ActivityWidget from "./widgets/ActivityWidget";

interface Props {
  projects: Project[];
  onNewProject: () => void;
  onScanFolder: () => void;
  onOpenGithub: () => void;
  onOpenExplorer: () => void;
  onOpenProjects: () => void;
  onOpenProject: (project: Project) => void;
}

/**
 * The dashboard landing: a registry-driven board of widgets. Each entry pairs a
 * column span with a render fn, so growing the dashboard = adding one item here
 * (and a widget component under `components/widgets/`). The 6-col grid collapses
 * to a single column on small screens.
 */
export default function DashboardHome({
  projects,
  onNewProject,
  onScanFolder,
  onOpenGithub,
  onOpenExplorer,
  onOpenProjects,
  onOpenProject,
}: Props) {
  const { statuses, loading } = useProjectStatuses(projects);

  const widgets: { id: string; span: string; render: () => ReactNode }[] = [
    {
      id: "quick-actions",
      span: "lg:col-span-6",
      render: () => (
        <QuickActionsWidget
          onNewProject={onNewProject}
          onScanFolder={onScanFolder}
          onOpenGithub={onOpenGithub}
          onOpenExplorer={onOpenExplorer}
        />
      ),
    },
    {
      id: "stats",
      span: "lg:col-span-2",
      render: () => <StatsWidget projects={projects} statuses={statuses} />,
    },
    {
      id: "recent",
      span: "lg:col-span-4",
      render: () => (
        <RecentProjectsWidget
          projects={projects}
          statuses={statuses}
          onOpen={onOpenProject}
          onViewAll={onOpenProjects}
        />
      ),
    },
    {
      id: "needs-attention",
      span: "lg:col-span-3",
      render: () => (
        <NeedsAttentionWidget
          projects={projects}
          statuses={statuses}
          loading={loading}
          onOpen={onOpenProject}
        />
      ),
    },
    {
      id: "activity",
      span: "lg:col-span-3",
      render: () => <ActivityWidget />,
    },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl p-5">
        <header className="mb-5">
          <h1 className="text-lg font-semibold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-500">
            Your control center — recent work and quick actions in one place.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-6">
          {widgets.map((w) => (
            <div key={w.id} className={w.span}>
              {w.render()}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
