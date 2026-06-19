import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiCall, Endpoint } from "../types";
import { detectApiCalls, detectEndpoints, writeFileText } from "../lib/tauri";
import { AlertIcon, CheckIcon, DownloadIcon, RefreshIcon, ServerIcon } from "./icons";

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-emerald-400/15 text-emerald-300",
  POST: "bg-accent/15 text-accent-soft",
  PUT: "bg-amber-400/15 text-amber-300",
  PATCH: "bg-amber-400/15 text-amber-300",
  DELETE: "bg-rose-500/15 text-rose-300",
  ANY: "bg-slate-500/15 text-slate-400",
};

/** Normalize a route/url to a comparable shape: drop host/query, params → `*`. */
function normalize(u: string): string {
  let p = u;
  if (p.startsWith("http")) {
    try {
      p = new URL(p).pathname;
    } catch {
      /* leave as-is */
    }
  }
  p = p.split("?")[0];
  const segs = p
    .split("/")
    .filter(Boolean)
    .map((s) => {
      if (s.startsWith(":") || (s.startsWith("{") && s.endsWith("}")) || s.includes("${") || /^\d+$/.test(s))
        return "*";
      return s.toLowerCase();
    });
  return "/" + segs.join("/");
}

/**
 * The app↔API contract view: what the API exposes vs what the app calls, with
 * drift flagged (calls to routes that don't exist, endpoints nothing calls).
 * "Write CONTRACT.md" snapshots this as a shared doc both sides can reference.
 */
export default function ContractPanel({
  rootPath,
  appPath,
  apiPath,
  notify,
}: {
  rootPath: string;
  appPath: string;
  apiPath: string;
  notify: (kind: "ok" | "err", message: string) => void;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [calls, setCalls] = useState<ApiCall[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([detectEndpoints(apiPath), detectApiCalls(appPath)])
      .then(([e, c]) => {
        setEndpoints(e);
        setCalls(c);
      })
      .catch((err) => notify("err", typeof err === "string" ? err : String(err)))
      .finally(() => setLoading(false));
  }, [apiPath, appPath, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const { endpointUsed, callMatched, unmatchedCalls, unusedEndpoints } = useMemo(() => {
    const eps = endpoints ?? [];
    const cs = calls ?? [];
    const epNorm = eps.map((e) => normalize(e.route));
    const callNorm = cs.map((c) => normalize(c.url));
    const callSet = new Set(callNorm);
    const epSet = new Set(epNorm);
    const endpointUsed = eps.map((_, i) => callSet.has(epNorm[i]));
    const callMatched = cs.map((_, i) => epSet.has(callNorm[i]));
    return {
      endpointUsed,
      callMatched,
      unmatchedCalls: cs.filter((_, i) => !callMatched[i]),
      unusedEndpoints: eps.filter((_, i) => !endpointUsed[i]),
    };
  }, [endpoints, calls]);

  async function writeContract() {
    if (!endpoints || !calls) return;
    setWriting(true);
    try {
      const md = buildContractMd(endpoints, calls, endpointUsed, callMatched);
      await writeFileText(`${rootPath}/CONTRACT.md`, md);
      notify("ok", "Wrote CONTRACT.md to the project root.");
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setWriting(false);
    }
  }

  if (loading && !endpoints) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-600">
        <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Comparing app ↔ API…
      </div>
    );
  }

  const driftCount = unmatchedCalls.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-4 py-3">
        <ServerIcon className="h-4 w-4 text-accent-soft" />
        <h2 className="text-sm font-semibold text-slate-100">App ↔ API contract</h2>
        <button onClick={load} title="Re-scan" className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-surface-hover hover:text-slate-200">
          <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          onClick={writeContract}
          disabled={writing}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-glow disabled:opacity-50"
        >
          {writing ? <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />}
          Write CONTRACT.md
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          {/* Drift banner */}
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
              driftCount > 0
                ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                : "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
            }`}
          >
            {driftCount > 0 ? <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />}
            <p>
              {driftCount > 0
                ? `${driftCount} app call${driftCount === 1 ? "" : "s"} hit routes the API doesn't expose (possible drift). ${unusedEndpoints.length} endpoint${unusedEndpoints.length === 1 ? "" : "s"} aren't called.`
                : `In sync — every app call maps to an API endpoint. ${unusedEndpoints.length} endpoint${unusedEndpoints.length === 1 ? "" : "s"} aren't called yet.`}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* API exposes */}
            <Group title={`API exposes (${endpoints?.length ?? 0})`} empty="No endpoints detected.">
              {endpoints?.map((e, i) => (
                <Row key={`${e.method}-${e.route}-${i}`} method={e.method} path={e.route} sub={`${e.file}:${e.line}`}>
                  <Tag ok={endpointUsed[i]} okLabel="used" warnLabel="unused" />
                </Row>
              ))}
            </Group>

            {/* App calls */}
            <Group title={`App calls (${calls?.length ?? 0})`} empty="No API calls detected in the app.">
              {calls?.map((c, i) => (
                <Row key={`${c.method}-${c.url}-${i}`} method={c.method} path={c.url} sub={`${c.file}:${c.line}`}>
                  <Tag ok={callMatched[i]} okLabel="matched" warnLabel="no endpoint" />
                </Row>
              ))}
            </Group>
          </div>

          <p className="text-[11px] text-slate-600">
            Heuristic match (params normalized to <span className="font-mono">*</span>). For request/response
            shapes + auto-updated <span className="font-mono">CLAUDE.md</span> references, use{" "}
            <span className="text-slate-400">Claude Code → “Sync API contract.”</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function Group({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : !!children;
  return (
    <section className="rounded-xl border border-surface-border bg-surface-card p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-600">{title}</h3>
      {hasChildren ? <div className="space-y-1">{children}</div> : <p className="py-2 text-xs text-slate-600">{empty}</p>}
    </section>
  );
}

function Row({
  method,
  path,
  sub,
  children,
}: {
  method: string;
  path: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface-base px-2 py-1.5">
      <span className={`w-14 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-bold ${METHOD_COLOR[method] ?? METHOD_COLOR.ANY}`}>
        {method}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-slate-200">{path}</div>
        <div className="truncate font-mono text-[10px] text-slate-600">{sub}</div>
      </div>
      {children}
    </div>
  );
}

function Tag({ ok, okLabel, warnLabel }: { ok: boolean; okLabel: string; warnLabel: string }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
        ok ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"
      }`}
    >
      {ok ? okLabel : warnLabel}
    </span>
  );
}

function buildContractMd(
  endpoints: Endpoint[],
  calls: ApiCall[],
  endpointUsed: boolean[],
  callMatched: boolean[]
): string {
  const lines: string[] = [
    "# API Contract",
    "",
    "_Generated by Kinetek from the code. The API is the source of truth; the app consumes it. Keep both `app/CLAUDE.md` and `api/CLAUDE.md` pointing here._",
    "",
    `## Endpoints the API exposes (${endpoints.length})`,
    "",
    "| Method | Route | Source | Used by app |",
    "| --- | --- | --- | --- |",
    ...endpoints.map(
      (e, i) => `| ${e.method} | \`${e.route}\` | ${e.file}:${e.line} | ${endpointUsed[i] ? "✅" : "—"} |`
    ),
    "",
    `## Calls the app makes (${calls.length})`,
    "",
    "| Method | URL | Source | Matches endpoint |",
    "| --- | --- | --- | --- |",
    ...calls.map(
      (c, i) => `| ${c.method} | \`${c.url}\` | ${c.file}:${c.line} | ${callMatched[i] ? "✅" : "⚠️ none"} |`
    ),
    "",
  ];
  const drift = calls.filter((_, i) => !callMatched[i]);
  if (drift.length) {
    lines.push("## ⚠️ Drift — app calls with no matching endpoint", "");
    for (const c of drift) lines.push(`- \`${c.method} ${c.url}\` (${c.file}:${c.line})`);
    lines.push("");
  }
  return lines.join("\n");
}
