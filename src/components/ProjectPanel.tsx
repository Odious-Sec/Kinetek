import { useEffect, useState } from "react";
import type { DirEntry, Project } from "../types";
import { openInFileManager } from "../lib/tauri";
import FileBrowser from "./FileBrowser";
import FileViewer from "./FileViewer";
import GitPanel from "./GitPanel";
import StatusBadge from "./StatusBadge";
import {
  CodeIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  MaximizeIcon,
  XIcon,
} from "./icons";

interface Props {
  project: Project;
  onClose: () => void;
  onOpenInEditor: (project: Project) => void;
  onExpand: (project: Project) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

/**
 * A right-side, read-only inspector: browse a project's file tree and preview
 * file contents before opening it in an IDE. Nothing is modified.
 */
export default function ProjectPanel({ project, onClose, onOpenInEditor, onExpand, notify }: Props) {
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [tab, setTab] = useState<"files" | "git">("files");

  // Reset state when switching projects.
  useEffect(() => {
    setSelected(null);
    setTab("files");
  }, [project.id]);

  const isSample = project.id.startsWith("sample-");

  async function reveal(entry: DirEntry) {
    try {
      await openInFileManager(entry.path);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-surface-border bg-surface-raised">
        {/* Header */}
        <div className="shrink-0 border-b border-surface-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-100">
                {project.name}
              </h2>
              <p className="truncate font-mono text-[11px] text-slate-500" title={project.path}>
                {project.path}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <StatusBadge status={project.status} />
              <button
                onClick={() => onExpand(project)}
                title="Expand to full page"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
              >
                <MaximizeIcon className="h-4 w-4" />
              </button>
              <button
                onClick={onClose}
                title="Close"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => onOpenInEditor(project)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow"
            >
              <CodeIcon className="h-3.5 w-3.5" />
              Open in editor
            </button>
            <button
              onClick={() => reveal({ name: project.name, path: project.path, isDir: true, hidden: false })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
            >
              <FolderIcon className="h-3.5 w-3.5" />
              Reveal
            </button>
          </div>

          {/* Files / Git tabs */}
          <div className="mt-2 flex items-center gap-1">
            <button
              onClick={() => setTab("files")}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === "files"
                  ? "bg-accent/15 text-accent-soft"
                  : "text-slate-400 hover:bg-surface-hover hover:text-slate-200"
              }`}
            >
              <FileIcon className="h-3.5 w-3.5" />
              Files
            </button>
            <button
              onClick={() => setTab("git")}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === "git"
                  ? "bg-accent/15 text-accent-soft"
                  : "text-slate-400 hover:bg-surface-hover hover:text-slate-200"
              }`}
            >
              <GitBranchIcon className="h-3.5 w-3.5" />
              Git
            </button>
            {tab === "files" && (
              <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => setShowHidden(e.target.checked)}
                  className="h-3 w-3 accent-accent"
                />
                Hidden
              </label>
            )}
          </div>
        </div>

        {isSample ? (
          <p className="px-4 py-4 text-xs text-slate-500">
            This is a sample card — scan or create a real project to browse its
            files and use git.
          </p>
        ) : tab === "git" ? (
          <GitPanel project={project} notify={notify} />
        ) : (
          <>
            {/* Tree / search */}
            <div className="min-h-0 basis-2/5 border-b border-surface-border p-2">
              <FileBrowser
                root={project.path}
                showHidden={showHidden}
                selectedPath={selected?.path ?? null}
                onOpenFile={setSelected}
                onReveal={reveal}
              />
            </div>

            {/* Viewer */}
            <div className="flex min-h-0 flex-1 flex-col">
              {selected ? (
                <FileViewer entry={selected} onReveal={reveal} />
              ) : (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-slate-600">
                  Select a file above to preview its contents.
                </div>
              )}
            </div>
          </>
        )}
    </div>
  );
}
