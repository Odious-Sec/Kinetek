import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { DirEntry, GitStatus, Project } from "../types";
import { gitStatus, openInFileManager, readDir } from "../lib/tauri";
import FileBrowser from "./FileBrowser";
import CommitGraph from "./CommitGraph";
import RefsSidebar from "./RefsSidebar";
import GitPanel from "./GitPanel";
import DiffViewer from "./DiffViewer";
import ClaudePanel from "./ClaudePanel";
import ApiPanel from "./ApiPanel";
import StatusBadge from "./StatusBadge";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  InfoIcon,
  ServerIcon,
  TerminalIcon,
  XIcon,
} from "./icons";

// xterm is heavy — keep it in its own lazy chunk (same module App lazy-loads).
const TerminalView = lazy(() => import("./TerminalView"));
// Monaco is heavy too — load the editor only when a file is opened.
const CodeEditor = lazy(() => import("./CodeEditor"));

type DockView = "claude" | "terminal";

/** Known monorepo parts, in display order. */
const PART_LABELS: Record<string, string> = { app: "App", api: "API", database: "Database" };
interface ProjectPart {
  name: string;
  label: string;
  path: string;
}

type Tab = "overview" | "files" | "api" | "history" | "git";

interface Props {
  project: Project;
  onBack: () => void;
  /** Open a folder (root/part) in the editor, optionally focusing a file. */
  onOpenPath: (path: string, file?: string) => void;
  /** Open the preview dialog for a (possibly sub-path) project. */
  onPreview: (project: Project) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

/**
 * Full-page project view. Everything about one project in one place: an
 * overview, a wide file browser + source viewer, the commit graph, and source
 * control. Reached via the "expand" button on the side inspector.
 */
export default function ProjectPage({ project, onBack, onOpenPath, onPreview, notify }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [ideMenuOpen, setIdeMenuOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  // Monorepo parts (app/api/database) for the IDE-style file switcher.
  const [parts, setParts] = useState<ProjectPart[]>([]);
  const [filePartPath, setFilePartPath] = useState<string | null>(null);
  // Bumped after any git ref/stash mutation so the sidebar + graph reload.
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const bumpGit = () => setGitRefreshKey((k) => k + 1);

  // Right dock (persistent across the left tabs): Claude Code or a terminal.
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [dockView, setDockView] = useState<DockView>("claude");
  // Don't spawn a shell until the user actually opens the Terminal once.
  const [termStarted, setTermStarted] = useState(false);
  const [claudeWidth, setClaudeWidth] = useState(460);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    setTab("overview");
    setSelected(null);
    setSelectedChange(null);
  }, [project.id]);

  // Detect app/api/database parts so Files can switch between them like an IDE.
  useEffect(() => {
    let cancelled = false;
    readDir(project.path)
      .then((entries) => {
        if (cancelled) return;
        const found: ProjectPart[] = ["app", "api", "database"].flatMap((n) => {
          const e = entries.find((x) => x.isDir && x.name === n);
          return e ? [{ name: n, label: PART_LABELS[n], path: e.path }] : [];
        });
        setParts(found);
        setFilePartPath(found[0]?.path ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setParts([]);
          setFilePartPath(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.path]);

  // Drag-to-resize the Claude dock.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const w = rect.right - e.clientX;
      setClaudeWidth(Math.min(Math.max(w, 320), rect.width - 360));
    }
    function onUp() {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = () => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  async function reveal(entry: DirEntry) {
    try {
      await openInFileManager(entry.path);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    }
  }

  const activePart = parts.find((p) => p.path === filePartPath) ?? null;

  // Preview targets the frontend: the `app/` part for assembled projects, else
  // the project root. (PreviewDialog auto-detects web/static/.NET on that path.)
  const appPart = parts.find((p) => p.name === "app");
  const apiPart = parts.find((p) => p.name === "api");
  const previewTarget: Project = appPart
    ? { ...project, path: appPart.path, name: `${project.name} · app` }
    : project;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", icon: <InfoIcon className="h-4 w-4" /> },
    { id: "files", label: "Files", icon: <FileIcon className="h-4 w-4" /> },
    ...(apiPart
      ? [{ id: "api" as Tab, label: "API", icon: <ServerIcon className="h-4 w-4" /> }]
      : []),
    { id: "history", label: "History", icon: <GitCommitIcon className="h-4 w-4" /> },
    { id: "git", label: "Source control", icon: <GitBranchIcon className="h-4 w-4" /> },
  ];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface-base">
      {/* Header */}
      <div className="shrink-0 border-b border-surface-border px-5 py-3">
        {/* Breadcrumb */}
        <nav className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
          <button
            onClick={onBack}
            className="rounded px-1 font-medium text-slate-400 transition-colors hover:text-accent-soft"
          >
            Projects
          </button>
          <ChevronRightIcon className="h-3.5 w-3.5 text-slate-600" />
          <span className="truncate text-slate-300">{project.name}</span>
        </nav>

        <div className="flex items-center gap-3">
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
              onClick={() => setClaudeOpen((o) => !o)}
              title="Toggle the Claude Code panel"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                claudeOpen
                  ? "border-accent/60 bg-accent/15 text-accent-soft"
                  : "border-surface-border bg-surface-card text-slate-200 hover:bg-surface-hover"
              }`}
            >
              <BotIcon className="h-3.5 w-3.5" />
              Claude Code
            </button>
            {/* Proceed to IDE — opens the whole project, or the part/file you're in */}
            <div className="relative">
              <div className="flex">
                <button
                  onClick={() => onOpenPath(project.path)}
                  title="Open the whole project in your editor"
                  className="inline-flex items-center gap-1.5 rounded-l-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow"
                >
                  <CodeIcon className="h-3.5 w-3.5" />
                  Proceed to IDE
                </button>
                <button
                  onClick={() => setIdeMenuOpen((o) => !o)}
                  title="Open options"
                  className="rounded-r-lg border-l border-white/20 bg-accent px-1.5 py-1.5 text-white transition-colors hover:bg-accent-glow"
                >
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              {ideMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setIdeMenuOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-surface-border bg-surface-raised p-1 shadow-glow">
                    <IdeMenuItem
                      label="Open whole project"
                      onClick={() => {
                        onOpenPath(project.path);
                        setIdeMenuOpen(false);
                      }}
                    />
                    {activePart && (
                      <IdeMenuItem
                        label={`Open ${activePart.label} folder`}
                        onClick={() => {
                          onOpenPath(activePart.path);
                          setIdeMenuOpen(false);
                        }}
                      />
                    )}
                    {selected && (
                      <IdeMenuItem
                        label="Open this file"
                        sub={selected.name}
                        onClick={() => {
                          // Open the part folder (or project) as the workspace,
                          // with this file focused.
                          onOpenPath(activePart?.path ?? project.path, selected.path);
                          setIdeMenuOpen(false);
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => onPreview(previewTarget)}
              title="Run a live preview of the app"
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
            >
              <EyeIcon className="h-3.5 w-3.5" />
              Preview
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

      {/* Body: workspace (left) + optional Claude Code dock (right) */}
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        {tab === "overview" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <Overview project={project} />
          </div>
        )}

        {tab === "files" && (
          <div className="flex h-full min-h-0">
            <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-surface-border">
              {/* Part switcher (App / API / Database) for assembled projects */}
              {parts.length > 0 && (
                <div className="flex shrink-0 items-center gap-0.5 border-b border-surface-border p-1.5">
                  {parts.map((p) => (
                    <button
                      key={p.path}
                      onClick={() => {
                        setFilePartPath(p.path);
                        setSelected(null);
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        filePartPath === p.path
                          ? "bg-accent/20 text-accent-soft"
                          : "text-slate-400 hover:bg-surface-hover hover:text-slate-200"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-hidden p-2">
                <FileBrowser
                  key={filePartPath ?? project.path}
                  root={filePartPath ?? project.path}
                  showHidden={showHidden}
                  selectedPath={selected?.path ?? null}
                  onOpenFile={setSelected}
                  onReveal={reveal}
                />
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {selected ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-xs text-slate-600">
                      Loading editor…
                    </div>
                  }
                >
                  <CodeEditor entry={selected} onReveal={reveal} notify={notify} />
                </Suspense>
              ) : (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-slate-600">
                  {parts.length > 0
                    ? "Pick App / API / Database above, then choose a file to edit its code."
                    : "Select a file to view and edit its code."}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "api" && apiPart && (
          <ApiPanel
            path={apiPart.path}
            onOpenFile={(rel) => onOpenPath(apiPart.path, `${apiPart.path}/${rel}`)}
            notify={notify}
          />
        )}

        {tab === "history" && (
          <div className="flex h-full min-h-0">
            <div className="w-56 shrink-0 border-r border-surface-border">
              <RefsSidebar
                project={project}
                refreshKey={gitRefreshKey}
                onChanged={bumpGit}
                notify={notify}
              />
            </div>
            <div className="min-w-0 flex-1">
              <CommitGraph
                project={project}
                refreshKey={gitRefreshKey}
                onChanged={bumpGit}
                notify={notify}
              />
            </div>
          </div>
        )}

        {tab === "git" && (
          <div className="flex h-full min-h-0">
            {/* Left: source control (commit / push / connect / changes) */}
            <div className="w-[24rem] shrink-0 overflow-hidden border-r border-surface-border">
              <GitPanel
                project={project}
                notify={notify}
                selectedChange={selectedChange}
                onSelectChange={setSelectedChange}
              />
            </div>
            {/* Right: the wasted space — a live diff of the selected change */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-3 py-2">
                <span className="truncate font-mono text-xs text-slate-400">
                  {selectedChange ?? "All local changes"}
                </span>
                <span className="ml-auto text-[10px] uppercase tracking-wider text-slate-600">
                  vs last commit
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <DiffViewer path={project.path} file={selectedChange} />
              </div>
            </div>
          </div>
        )}
        </div>

        {/* Resizable Claude Code dock — stays on the right while you work */}
        {claudeOpen && (
          <>
            <div
              onMouseDown={startDrag}
              title="Drag to resize"
              className="w-1 shrink-0 cursor-col-resize bg-surface-border transition-colors hover:bg-accent/50"
            />
            <div
              style={{ width: claudeWidth }}
              className="flex shrink-0 flex-col border-l border-surface-border"
            >
              <div className="flex shrink-0 items-center gap-1 border-b border-surface-border px-2 py-1.5">
                <div className="flex items-center gap-0.5 rounded-lg bg-surface-base p-0.5">
                  <DockTab
                    active={dockView === "claude"}
                    icon={<BotIcon className="h-3.5 w-3.5" />}
                    label="Claude Code"
                    onClick={() => setDockView("claude")}
                  />
                  <DockTab
                    active={dockView === "terminal"}
                    icon={<TerminalIcon className="h-3.5 w-3.5" />}
                    label="Terminal"
                    onClick={() => {
                      setDockView("terminal");
                      setTermStarted(true);
                    }}
                  />
                </div>
                <button
                  onClick={() => setClaudeOpen(false)}
                  title="Close panel"
                  className="ml-auto rounded p-1 text-slate-500 transition-colors hover:bg-surface-hover hover:text-slate-200"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Keep both mounted so switching tabs doesn't kill a run/shell. */}
              <div className={`min-h-0 flex-1 ${dockView === "claude" ? "" : "hidden"}`}>
                <ClaudePanel project={project} notify={notify} />
              </div>
              {termStarted && (
                <div className={`min-h-0 flex-1 ${dockView === "terminal" ? "" : "hidden"}`}>
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-xs text-slate-600">
                        Loading terminal…
                      </div>
                    }
                  >
                    <TerminalView cwd={project.path} />
                  </Suspense>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IdeMenuItem({
  label,
  sub,
  onClick,
}: {
  label: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full flex-col rounded-md px-2.5 py-1.5 text-left text-xs text-slate-200 transition-colors hover:bg-surface-hover"
    >
      <span>{label}</span>
      {sub && <span className="truncate font-mono text-[10px] text-slate-500">{sub}</span>}
    </button>
  );
}

function DockTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? "bg-accent/20 text-accent-soft" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {icon}
      {label}
    </button>
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
    <div className="p-6">
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
