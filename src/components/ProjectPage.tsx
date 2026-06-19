import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { DirEntry, GitStatus, Project } from "../types";
import { gitStatus, openInFileManager, readDir, writeFileText } from "../lib/tauri";
import FileBrowser from "./FileBrowser";
import CommitGraph from "./CommitGraph";
import RefsSidebar from "./RefsSidebar";
import GitPanel from "./GitPanel";
import DiffViewer from "./DiffViewer";
import ClaudePanel from "./ClaudePanel";
import ApiPanel from "./ApiPanel";
import ContractPanel from "./ContractPanel";
import StatusBadge from "./StatusBadge";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  EyeIcon,
  GitCompareIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  InfoIcon,
  ServerIcon,
  SparkIcon,
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

type Tab = "overview" | "files" | "api" | "contract" | "history" | "git";

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
  // Bumped after writing files so the file tree re-reads from disk.
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const [docsBusy, setDocsBusy] = useState(false);
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

  // One-click context docs: a root CLAUDE.md mapping the parts + a CLAUDE.md in
  // each part folder. Scaffolded from Kinetek's known structure (no LLM) so it's
  // instant and works even without Claude Code installed.
  async function writeContextDocs() {
    if (docsBusy) return;
    setDocsBusy(true);
    try {
      const docs = buildContextDocs(project, parts);
      await Promise.all(docs.map((d) => writeFileText(d.path, d.content)));
      setFilesRefreshKey((k) => k + 1);
      notify("ok", `Wrote ${docs.length} context file${docs.length === 1 ? "" : "s"}.`);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setDocsBusy(false);
    }
  }
  // Show the docs button once we know the project has at least one known part.
  const canWriteDocs = parts.length > 0;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", icon: <InfoIcon className="h-4 w-4" /> },
    { id: "files", label: "Files", icon: <FileIcon className="h-4 w-4" /> },
    ...(apiPart
      ? [{ id: "api" as Tab, label: "API", icon: <ServerIcon className="h-4 w-4" /> }]
      : []),
    ...(appPart && apiPart
      ? [{ id: "contract" as Tab, label: "Contract", icon: <GitCompareIcon className="h-4 w-4" /> }]
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
            {/* Claude Code lives with the Files tab so its context (the files
                you're viewing) is unambiguous — hidden on the other tabs. */}
            {tab === "files" && (
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
            )}
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
            <div className="ml-auto flex items-center gap-3">
              {canWriteDocs && (
                <button
                  onClick={writeContextDocs}
                  disabled={docsBusy}
                  title="Write a root CLAUDE.md mapping the parts (Claude Code auto-loads it) + a CLAUDE.md inside each part folder"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent-soft transition-colors hover:bg-accent/15 disabled:opacity-50"
                >
                  <SparkIcon className="h-3.5 w-3.5" />
                  {docsBusy ? "Writing…" : "Context docs"}
                </button>
              )}
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => setShowHidden(e.target.checked)}
                  className="h-3 w-3 accent-accent"
                />
                Show hidden
              </label>
            </div>
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
                  key={`${filePartPath ?? project.path}:${filesRefreshKey}`}
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

        {tab === "contract" && appPart && apiPart && (
          <ContractPanel
            rootPath={project.path}
            appPath={appPart.path}
            apiPath={apiPart.path}
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

        {/* Resizable Claude Code dock — tied to the Files tab. Kept mounted (so a
            running chat/terminal survives) but hidden on the other tabs via
            `display: contents` ↔ `hidden`. */}
        {claudeOpen && (
          <div className={tab === "files" ? "contents" : "hidden"}>
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
          </div>
        )}
      </div>
    </div>
  );
}

/** A part's one-line role, used across the generated docs. */
const PART_ROLE: Record<string, string> = {
  app: "the user-facing application (frontend / client)",
  api: "the backend service the app talks to (endpoints + data)",
  database: "the data layer — schema, migrations, seed data",
};

/**
 * Scaffold context docs from Kinetek's known structure (no LLM): a root
 * `CLAUDE.md` mapping the parts (Claude Code auto-loads this name, so the agent
 * discovers the layout on its own) and a `CLAUDE.md` inside each part folder.
 * Returns the files to write; pure so it's easy to reason about.
 */
function buildContextDocs(
  project: Project,
  parts: ProjectPart[]
): { path: string; content: string }[] {
  const has = (n: string) => parts.some((p) => p.name === n);
  const stack = project.frameworks.length ? project.frameworks.join(", ") : "not detected";
  const summary =
    project.summary?.trim() || "_No summary yet — use “Explain” on the project to generate one._";

  // Root CLAUDE.md — the agent-facing map of how the parts fit together. Named
  // CLAUDE.md (not CONTEXT.md) so Claude Code picks it up automatically.
  const partRows = parts
    .map(
      (p) =>
        `| **${p.label}** | \`${p.name}/\` | ${PART_ROLE[p.name] ?? "project part"} | [\`${p.name}/CLAUDE.md\`](./${p.name}/CLAUDE.md) |`
    )
    .join("\n");
  const connect =
    has("app") && has("api")
      ? "\n## How the parts connect\n\nThe **app** (`app/`) calls the **API** (`api/`). Treat the API as the source of truth for endpoints and data shapes, and keep both sides in sync. Each part's own `CLAUDE.md` points back here.\n"
      : "";
  const root = `# ${project.name}

> Agent context for Claude Code, auto-generated by Kinetek from the project's
> structure. Regenerate any time from the **Files** tab → **Context docs**.

${summary}

**Stack:** ${stack}

## Project layout

This project is split into parts. **Work in the folder that matches the task,
and leave the others alone unless the task explicitly spans them.** Each part
has its own \`CLAUDE.md\` with details specific to it.

| Part | Folder | What it is | Details |
|------|--------|------------|---------|
${partRows}
${connect}
## Ground rules

${parts.map((p) => `- ${PART_ROLE[p.name] ?? "This part"} → \`${p.name}/\``).join("\n")}
- Keep changes scoped to one part unless told otherwise.
`;

  const docs = [{ path: `${project.path}/CLAUDE.md`, content: root }];

  // A CLAUDE.md inside each part folder with that part's context.
  for (const p of parts) {
    const others = parts.filter((o) => o.name !== p.name);
    const rel =
      others.length > 0
        ? `\n## Related parts\n\n${others
            .map((o) => `- \`../${o.name}/\` — ${PART_ROLE[o.name] ?? "another part"}.`)
            .join("\n")}\n\nThe full map is in the [root \`CLAUDE.md\`](../CLAUDE.md).\n`
        : "";
    docs.push({
      path: `${p.path}/CLAUDE.md`,
      content: `# ${p.label} — ${project.name}

> Auto-generated by Kinetek. Agent context for the \`${p.name}/\` part.

This is **${PART_ROLE[p.name] ?? "a part"}** of **${project.name}**.

**Stack:** ${stack}

## Working in this folder

- Keep changes scoped to \`${p.name}/\` unless a task explicitly spans parts.
${p.name === "app" && has("api") ? "- When you call the API, match the shapes the `api/` part exposes (see the root `../CLAUDE.md`).\n" : ""}${p.name === "api" && has("app") ? "- The `app/` part depends on these endpoints — keep them backward-compatible or update the app in lockstep.\n" : ""}- Document key entry points and conventions here as the code grows.
${rel}`,
    });
  }

  return docs;
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
