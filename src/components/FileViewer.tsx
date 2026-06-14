import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/atom-one-dark.css";
import type { DirEntry, FileContent } from "../types";
import { readFileText } from "../lib/tauri";
import { ExternalLinkIcon, FileIcon } from "./icons";

export function formatBytes(n: number): string {
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

/**
 * Read-only source viewer with syntax highlighting. Shows the file's bytes as
 * code (HTML is escaped, never rendered).
 */
export default function FileViewer({
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
