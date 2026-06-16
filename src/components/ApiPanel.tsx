import { useCallback, useEffect, useMemo, useState } from "react";
import type { Endpoint } from "../types";
import { detectEndpoints } from "../lib/tauri";
import { RefreshIcon, SearchIcon, ServerIcon } from "./icons";

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-emerald-400/15 text-emerald-300",
  POST: "bg-accent/15 text-accent-soft",
  PUT: "bg-amber-400/15 text-amber-300",
  PATCH: "bg-amber-400/15 text-amber-300",
  DELETE: "bg-rose-500/15 text-rose-300",
  ANY: "bg-slate-500/15 text-slate-400",
};

/**
 * The API explorer: a plain-English map of what the API exposes — every detected
 * HTTP route (method · path · source), so you can see the surface before opening
 * an IDE. Detection is heuristic (Express/NestJS/FastAPI/Flask/ASP.NET/Go).
 * Clicking a route opens its file in the editor.
 */
export default function ApiPanel({
  path,
  onOpenFile,
  notify,
}: {
  path: string;
  onOpenFile: (relFile: string) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    detectEndpoints(path)
      .then(setEndpoints)
      .catch((e) => {
        notify("err", typeof e === "string" ? e : String(e));
        setEndpoints([]);
      })
      .finally(() => setLoading(false));
  }, [path, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!endpoints) return [];
    const q = query.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter(
      (e) => e.route.toLowerCase().includes(q) || e.method.toLowerCase().includes(q)
    );
  }, [endpoints, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-4 py-3">
        <ServerIcon className="h-4 w-4 text-accent-soft" />
        <h2 className="text-sm font-semibold text-slate-100">API endpoints</h2>
        {endpoints && (
          <span className="rounded-full bg-surface-card px-2 py-0.5 text-[11px] text-slate-500">
            {endpoints.length}
          </span>
        )}
        <button
          onClick={load}
          title="Re-scan"
          className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-surface-hover hover:text-slate-200"
        >
          <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {endpoints && endpoints.length > 0 && (
        <div className="shrink-0 px-4 pt-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter routes…"
              className="w-full rounded-lg border border-surface-border bg-surface-base py-1.5 pl-8 pr-2 text-xs text-slate-100 outline-none focus:border-accent/50"
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading && !endpoints ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">
            <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Scanning the API…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-500">
            <ServerIcon className="h-6 w-6 text-slate-700" />
            <p>
              {endpoints && endpoints.length > 0
                ? "No routes match your filter."
                : "No endpoints detected. Supported: Express, NestJS, FastAPI, Flask, ASP.NET, Go."}
            </p>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-1.5">
            {visible.map((e, i) => (
              <li key={`${e.method}-${e.route}-${e.file}-${e.line}-${i}`}>
                <button
                  onClick={() => onOpenFile(e.file)}
                  title={`Open ${e.file}:${e.line}`}
                  className="flex w-full items-center gap-3 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-surface-hover"
                >
                  <span
                    className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-bold tracking-wide ${
                      METHOD_COLOR[e.method] ?? METHOD_COLOR.ANY
                    }`}
                  >
                    {e.method}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-slate-200">
                    {e.route}
                  </span>
                  <span className="shrink-0 truncate font-mono text-[10px] text-slate-600">
                    {e.file}:{e.line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
