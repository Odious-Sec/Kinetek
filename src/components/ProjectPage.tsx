import { useEffect, useState } from "react";
import type { DirEntry, GitStatus, Project } from "../types";
import { gitStatus, openInFileManager } from "../lib/tauri";
import FileBrowser from "./FileBrowser";
import FileViewer from "./FileViewer";
import CommitGraph from "./CommitGraph";
import GitPanel from "./GitPanel";
import StatusBadge from "./StatusBadge";
import {
  CodeIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  InfoIcon,
  MinimizeIcon,
} from "./icons";

type Tab = "overview" | "files" | "history" | "git";

interface Props {
  project: Project;
  onBack: () => void;
  onOpenInEditor: (project: Project) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

/**
 * Full-page project view. Everything about one project in one place: an
 * overview, a wide file browser + source viewer, the commit graph, and source
 * control. Reached via the "expand" button on the side inspector.
 */
export default function ProjectPage({ project, onBack, onOpenInEditor, notify }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<DirEntry | null>(null);

  useEffect(() => {
    setTab("overview");
    setSelected(null);
  }, [project.id]);

  async function reveal(entry: DirEntry) {
    try {
      await openInFileManager(entry.path);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", icon: <InfoIcon className="h-4 w-4" /> },
    { id: "files", label: "Files", icon: <FileIcon className="h-4 w-4" /> },
    { id: "history", label: "History", icon: <GitCommitIcon className="h-4 w-4" /> },
    { id: "git", label: "Source control", icon: <GitBranchIcon className="h-4 w-4" /> },
  ];

  return (
    <div className="flex h-full flex-col bg-surface-base">
      {/* Header */}
      <div className="shrink-0 border-b border-surface-border px-5 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            title="Back to dashboard"
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
          >
            <MinimizeIcon className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold text-slate-100">
                {project.name}
              </h1>
              <StatusBadge status={project.status} />
            </div>
            <p className="truncate font-mono text-[11px] text-slate-500" title={project.path}>
              {project.path}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              onClick={() => onOpenInEditor(project)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow"
            >
              <CodeIcon className="h-3.5 w-3.5" />
              Open in editor
            </button>
            <button
              onClick={() =>
                reveal({ name: project.name, path: project.path, isDir: true, hidden: false })
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
            >
              <FolderIcon className="h-3.5 w-3.5" />
              Reveal
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-3 flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-accent/15 text-accent-soft"
                  : "text-slate-400 hover:bg-surface-hover hover:text-slate-200"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
          {tab === "files" && (
            <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="h-3 w-3 accent-accent"
              />
              Show hidden
            </label>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {tab === "overview" && <Overview project={project} />}

        {tab === "files" && (
          <div className="flex h-full min-h-0">
            <div className="w-72 shrink-0 overflow-hidden border-r border-surface-border p-2">
              <FileBrowser
                root={project.path}
                showHidden={showHidden}
                selectedPath={selected?.path ?? null}
                onOpenFile={setSelected}
                onReveal={reveal}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {selected ? (
                <FileViewer entry={selected} onReveal={reveal} />
              ) : (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-600">
                  Select a file to preview its contents.
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "history" && <CommitGraph project={project} />}

        {tab === "git" && (
          <div className="mx-auto h-full max-w-2xl">
            <GitPanel project={project} notify={notify} />
          </div>
        )}
      </div>
    </div>
  );
}

function Overview({ project }: { project: Project }) {
  const [status, setStatus] = useState<GitStatus | null | "loading">("loading");

  useEffect(() => {
    setStatus("loading");
    gitStatus(project.path)
      .then((s) => setStatus(s))
      .catch(() => setStatus(null));
  }, [project.path]);

  return (
    <div className="mx-auto max-w-3xl overflow-auto p-6">
      <section className="rounded-2xl border border-surface-border bg-surface-card p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          Summary
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          {project.summary || "No summary yet — open the project and use “Explain” to generate one."}
        </p>
        {project.frameworks.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {project.frameworks.map((f) => (
              <span
                key={f}
                className="rounded-md bg-surface-base px-2 py-1 text-[11px] font-medium text-slate-400"
              >
                {f}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-surface-border bg-surface-card p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          Git
        </h2>
        {status === "loading" ? (
          <p className="mt-2 text-sm text-slate-500">Checking…</p>
        ) : status === null ? (
          <p className="mt-2 text-sm text-slate-500">Not a git repository.</p>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Stat label="Branch" value={status.branch} />
            <Stat label="State" value={status.dirty ? "Uncommitted changes" : "Clean"} />
            <Stat
              label="Sync"
              value={
                status.ahead || status.behind
                  ? `${status.ahead ? `↑${status.ahead}` : ""} ${status.behind ? `↓${status.behind}` : ""}`.trim()
                  : "Up to date"
              }
            />
            {status.lastCommit && (
              <div className="col-span-2 sm:col-span-3">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                  Last commit
                </dt>
                <dd className="mt-0.5 text-slate-300">
                  {status.lastCommit}
                  {status.lastCommitRelative && (
                    <span className="text-slate-600"> · {status.lastCommitRelative}</span>
                  )}
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-surface-border bg-surface-card p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          Location
        </h2>
        <p className="mt-2 break-all font-mono text-xs text-slate-400">{project.path}</p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">
        {label}
      </dt>
      <dd className="mt-0.5 text-slate-300">{value}</dd>
    </div>
  );
}
