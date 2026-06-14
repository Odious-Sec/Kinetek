import { useMemo, useState } from "react";
import type { Folder, Project, ProjectStatus } from "../types";
import ProjectCard from "./ProjectCard";
import type { FolderSelection } from "./Sidebar";
import { PlusIcon, SearchIcon, RefreshIcon, FolderIcon } from "./icons";

type Filter = "All" | ProjectStatus;
const FILTERS: Filter[] = ["All", "Live", "In Development", "On Hold"];

interface Props {
  projects: Project[];
  scanning: boolean;
  /** True when the inspector panel is open and the grid has less room. */
  narrow: boolean;
  folders: Folder[];
  assignments: Record<string, string>;
  selectedFolder: FolderSelection;
  explainingId: string | null;
  onNewProject: () => void;
  onScanFolder: () => void;
  onProceedToCode: (project: Project) => void;
  onPreview: (project: Project) => void;
  onReveal: (project: Project) => void;
  onDelete: (project: Project) => void;
  onAssignFolder: (project: Project, folderId: string | null) => void;
  onEdit: (project: Project) => void;
  onExplain: (project: Project) => void;
  onSelect: (project: Project) => void;
}

export default function Dashboard({
  projects,
  scanning,
  narrow,
  folders,
  assignments,
  selectedFolder,
  explainingId,
  onNewProject,
  onScanFolder,
  onProceedToCode,
  onPreview,
  onReveal,
  onDelete,
  onAssignFolder,
  onEdit,
  onExplain,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      const folderId = assignments[p.id];
      const matchesFolder =
        selectedFolder === "all"
          ? true
          : selectedFolder === "unfiled"
          ? !folderId
          : folderId === selectedFolder;
      const matchesFilter = filter === "All" || p.status === filter;
      const matchesQuery =
        q.length === 0 ||
        p.name.toLowerCase().includes(q) ||
        p.summary.toLowerCase().includes(q) ||
        p.frameworks.some((f) => f.toLowerCase().includes(q));
      return matchesFolder && matchesFilter && matchesQuery;
    });
  }, [projects, query, filter, selectedFolder, assignments]);

  const counts = useMemo(() => {
    return {
      total: filtered.length,
      live: filtered.filter((p) => p.status === "Live").length,
      dev: filtered.filter((p) => p.status === "In Development").length,
    };
  }, [filtered]);

  const heading =
    selectedFolder === "all"
      ? "Your Projects"
      : selectedFolder === "unfiled"
      ? "Unfiled"
      : folders.find((f) => f.id === selectedFolder)?.name ?? "Projects";

  return (
    <div className="flex h-full flex-col">
      {/* Hero / header */}
      <header className="shrink-0 px-8 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
              {heading}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {counts.total} projects · {counts.live} live · {counts.dev} in
              development
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onScanFolder}
              className="no-drag inline-flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card px-3.5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
            >
              <FolderIcon className="h-4 w-4" />
              Scan a Folder
            </button>
            <button
              onClick={onNewProject}
              className="no-drag inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-glow transition-colors hover:bg-accent-glow"
            >
              <PlusIcon className="h-4 w-4" />
              New Project
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects, summaries, or frameworks…"
              className="w-full rounded-lg border border-surface-border bg-surface-card py-2 pl-9 pr-3 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/50"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-surface-border bg-surface-card p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f
                    ? "bg-accent/20 text-accent-soft"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {scanning && (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
              <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
              Scanning…
            </span>
          )}
        </div>
      </header>

      {/* Grid */}
      <main className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-6">
        {filtered.length === 0 ? (
          <EmptyState hasProjects={projects.length > 0} onNewProject={onNewProject} />
        ) : (
          <div
            className={
              narrow
                ? "grid grid-cols-1 gap-4 lg:grid-cols-2"
                : "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            }
          >
            {filtered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                folders={folders}
                currentFolderId={assignments[project.id] ?? null}
                explaining={explainingId === project.id}
                onProceedToCode={onProceedToCode}
                onPreview={onPreview}
                onReveal={onReveal}
                onDelete={onDelete}
                onAssignFolder={onAssignFolder}
                onEdit={onEdit}
                onExplain={onExplain}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState({
  hasProjects,
  onNewProject,
}: {
  hasProjects: boolean;
  onNewProject: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-surface-border py-20 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-card text-slate-500">
        <FolderIcon className="h-7 w-7" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-slate-200">
        {hasProjects ? "No projects match your filters" : "No projects yet"}
      </h3>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        {hasProjects
          ? "Try a different search term or status filter."
          : "Bootstrap a fresh template or scan an existing folder to get started."}
      </p>
      {!hasProjects && (
        <button
          onClick={onNewProject}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
        >
          <PlusIcon className="h-4 w-4" />
          Create your first project
        </button>
      )}
    </div>
  );
}
