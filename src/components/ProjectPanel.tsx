import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/atom-one-dark.css";
import type { DirEntry, FileContent, Project } from "../types";
import { openInFileManager, readFileText } from "../lib/tauri";
import FileBrowser from "./FileBrowser";
import GitPanel from "./GitPanel";
import StatusBadge from "./StatusBadge";
import {
  CodeIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  XIcon,
} from "./icons";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// File extension → highlight.js language. HTML maps to "xml" so it's shown as
// SOURCE (escaped, colored), never rendered.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", less: "less",
  rs: "rust", py: "python", rb: "ruby", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  md: "markdown", markdown: "markdown",
  sql: "sql", lua: "lua", r: "r", pl: "perl",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Return highlighted HTML (tokens escaped by highlight.js — safe to inject). */
function highlightCode(name: string, code: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const lang = EXT_LANG[ext];
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

interface Props {
  project: Project;
  onClose: () => void;
  onOpenInEditor: (project: Project) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

/**
 * A right-side, read-only inspector: browse a project's file tree and preview
 * file contents before opening it in an IDE. Nothing is modified.
 */
export default function ProjectPanel({ project, onClose, onOpenInEditor, notify }: Props) {
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
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={project.status} />
              <button
                onClick={onClose}
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

function FileViewer({
  entry,
  onReveal,
}: {
  entry: DirEntry;
  onReveal: (entry: DirEntry) => void;
}) {
  const [data, setData] = useState<FileContent | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const html = useMemo(
    () =>
      data && !data.binary && !data.tooLarge
        ? highlightCode(entry.name, data.content)
        : "",
    [data, entry.name]
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    setLoading(true);
    readFileText(entry.path)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(typeof e === "string" ? e : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [entry.path]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-3 py-2">
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">
          {entry.name}
        </span>
        {data && (
          <span className="shrink-0 text-[10px] text-slate-600">
            {formatBytes(data.size)}
          </span>
        )}
        <button
          onClick={() => onReveal(entry)}
          title="Open externally"
          className="shrink-0 rounded p-1 text-slate-500 hover:text-slate-200"
        >
          <ExternalLinkIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <p className="p-3 text-xs text-slate-600">Loading…</p>}
        {error && <p className="p-3 text-xs text-rose-300/80">{error}</p>}
        {data && data.binary && (
          <p className="p-3 text-xs text-slate-500">
            This looks like a binary file and can't be previewed as text.
          </p>
        )}
        {data && data.tooLarge && (
          <p className="p-3 text-xs text-slate-500">
            This file is large ({formatBytes(data.size)}) — open it externally to view it.
          </p>
        )}
        {data && !data.binary && !data.tooLarge && (
          <>
            <pre
              data-selectable="true"
              className="hljs block min-h-full whitespace-pre p-3 font-mono text-[11px] leading-relaxed"
            >
              <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
            {data.truncated && (
              <p className="px-3 pb-3 text-[11px] text-slate-600">
                …(truncated for preview)
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
