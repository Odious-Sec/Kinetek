import { useEffect, useState } from "react";
import type { Folder, GitStatus, Project } from "../types";
import { gitStatus } from "../lib/tauri";
import StatusBadge from "./StatusBadge";
import FrameworkTag from "./FrameworkTag";
import {
  CodeIcon,
  EyeIcon,
  FolderIcon,
  PencilIcon,
  RefreshIcon,
  SparkIcon,
  TrashIcon,
} from "./icons";

interface Props {
  project: Project;
  folders: Folder[];
  currentFolderId: string | null;
  explaining: boolean;
  onProceedToCode: (project: Project) => void;
  onPreview: (project: Project) => void;
  onReveal: (project: Project) => void;
  onDelete: (project: Project) => void;
  onAssignFolder: (project: Project, folderId: string | null) => void;
  onEdit: (project: Project) => void;
  onExplain: (project: Project) => void;
  onSelect: (project: Project) => void;
}

export default function ProjectCard({
  project,
  folders,
  currentFolderId,
  explaining,
  onProceedToCode,
  onPreview,
  onReveal,
  onDelete,
  onAssignFolder,
  onEdit,
  onExplain,
  onSelect,
}: Props) {
  const [git, setGit] = useState<GitStatus | null>(null);

  // Best-effort local git status (sample cards have placeholder paths).
  useEffect(() => {
    if (project.id.startsWith("sample-")) return;
    let cancelled = false;
    gitStatus(project.path)
      .then((g) => {
        if (!cancelled) setGit(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.path, project.id]);

  return (
    <div
      onClick={() => onSelect(project)}
      title="View this project's files"
      className="group relative flex cursor-pointer flex-col rounded-2xl border border-surface-border bg-surface-card p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow animate-fade-in"
    >
      {/* Header: name + status + quick actions */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="block max-w-full truncate text-base font-semibold text-slate-100 transition-colors group-hover:text-accent-soft">
            {project.name}
          </h3>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReveal(project);
            }}
            title={project.path}
            className="no-drag mt-0.5 flex max-w-full items-center gap-1 truncate text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <FolderIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{project.path}</span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <button
              onClick={() => onExplain(project)}
              disabled={explaining}
              title="Explain this project with AI"
              className="no-drag rounded-md p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-accent-soft disabled:opacity-50"
            >
              {explaining ? (
                <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <SparkIcon className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => onEdit(project)}
              title="Edit project details"
              className="no-drag rounded-md p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <StatusBadge status={project.status} />
        </div>
      </div>

      {/* Git status */}
      {git && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1 font-mono text-slate-400">
            <span className="text-slate-600">⎇</span>
            {git.branch}
            {git.dirty && (
              <span title="Uncommitted changes" className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            )}
          </span>
          {(git.ahead > 0 || git.behind > 0) && (
            <span className="font-mono">
              {git.ahead > 0 && <span title="commits ahead">↑{git.ahead}</span>}
              {git.ahead > 0 && git.behind > 0 && " "}
              {git.behind > 0 && <span title="commits behind">↓{git.behind}</span>}
            </span>
          )}
          {git.lastCommit && (
            <span className="truncate">
              {git.lastCommit}
              {git.lastCommitRelative ? ` · ${git.lastCommitRelative}` : ""}
            </span>
          )}
        </div>
      )}

      {/* Plain English Summary */}
      <p
        data-selectable="true"
        className="mt-3 line-clamp-3 text-sm leading-relaxed text-slate-400"
      >
        {project.summary || "No summary yet — add one, or use ✨ to let AI describe it."}
      </p>

      {/* Framework tags */}
      {project.frameworks.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {project.frameworks.map((fw) => (
            <FrameworkTag key={fw} label={fw} />
          ))}
        </div>
      )}

      {/* Folder assignment */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="no-drag mt-3 flex items-center gap-2"
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <div className="relative flex-1">
          <select
            value={currentFolderId ?? ""}
            onChange={(e) => onAssignFolder(project, e.target.value || null)}
            title="Organize this project into a folder"
            className="w-full cursor-pointer appearance-none rounded-lg border border-surface-border bg-surface-raised py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-300 outline-none transition-colors hover:bg-surface-hover focus:border-accent/50"
          >
            <option value="">Unfiled</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-500">
            ▾
          </span>
        </div>
      </div>

      {/* Actions */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-5 flex items-center gap-2 border-t border-surface-border pt-4"
      >
        <button
          onClick={() => onProceedToCode(project)}
          className="no-drag inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
        >
          <CodeIcon className="h-4 w-4" />
          Proceed to Code
        </button>
        <button
          onClick={() => onPreview(project)}
          title="Run a live preview of this project"
          className="no-drag inline-flex items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
        >
          <EyeIcon className="h-4 w-4" />
          Preview
        </button>
        <button
          onClick={() => onDelete(project)}
          title="Move this project to the Trash"
          className="no-drag inline-flex items-center justify-center rounded-lg border border-surface-border bg-surface-raised p-2 text-slate-400 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
