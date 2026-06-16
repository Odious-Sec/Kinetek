import { useEffect, useMemo, useState } from "react";
import type { Commit, Project } from "../types";
import { gitCreateBranch, gitLog } from "../lib/tauri";
import { CheckIcon, GitBranchIcon, GitCommitIcon, RefreshIcon, XIcon } from "./icons";

/**
 * A Fork-style commit graph: each commit is a row; a coloured lane gutter on
 * the left draws the branch/merge topology with an SVG overlay. Click a commit
 * to see its full details on the right.
 */

const ROW_H = 34; // px per commit row
const COL_W = 16; // px per lane column
const PAD_X = 14; // left padding before the first lane
const DOT_R = 4.5;

// A small, distinct palette cycled across lanes.
const LANE_COLORS = [
  "#60a5fa", // blue
  "#f472b6", // pink
  "#34d399", // emerald
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#a3e635", // lime
];

interface PlacedNode {
  commit: Commit;
  row: number;
  col: number;
}
interface Edge {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  color: string;
}

/**
 * Assign each commit a lane (column) using the classic reservation algorithm,
 * then derive the edges connecting children to parents. Commits arrive newest
 * first (children before parents), which keeps lanes stable top-to-bottom.
 */
function layout(commits: Commit[]): {
  nodes: PlacedNode[];
  edges: Edge[];
  cols: number;
} {
  const rowOf = new Map<string, number>();
  commits.forEach((c, i) => rowOf.set(c.hash, i));

  const lanes: (string | null)[] = []; // hash each active lane is waiting for
  const nodes: PlacedNode[] = [];
  const colOf = new Map<string, number>();
  let maxCols = 1;

  commits.forEach((c, row) => {
    // Find (or open) this commit's lane.
    let col = lanes.findIndex((l) => l === c.hash);
    if (col === -1) {
      col = lanes.findIndex((l) => l === null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(c.hash);
      } else {
        lanes[col] = c.hash;
      }
    }
    nodes.push({ commit: c, row, col });
    colOf.set(c.hash, col);

    // Route lanes to parents we actually have in the list.
    const parents = c.parents.filter((p) => rowOf.has(p));
    if (parents.length === 0) {
      lanes[col] = null; // root / orphan — lane ends here
    } else {
      lanes[col] = parents[0]; // first parent keeps the lane (straight line)
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k];
        if (lanes.includes(p)) continue; // already converging elsewhere
        let nl = lanes.findIndex((l) => l === null);
        if (nl === -1) {
          nl = lanes.length;
          lanes.push(p);
        } else {
          lanes[nl] = p;
        }
      }
    }
    // Collapse duplicate reservations of the same parent (leftmost wins).
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) continue;
      for (let j = i + 1; j < lanes.length; j++) {
        if (lanes[j] === lanes[i]) lanes[j] = null;
      }
    }
    maxCols = Math.max(maxCols, lanes.length);
  });

  // Build edges once every node has a column.
  const edges: Edge[] = [];
  for (const n of nodes) {
    for (const ph of n.commit.parents) {
      const pr = rowOf.get(ph);
      if (pr === undefined) continue;
      const pc = colOf.get(ph)!;
      edges.push({
        fromRow: n.row,
        fromCol: n.col,
        toRow: pr,
        toCol: pc,
        // Colour by the destination lane so a branch reads as one colour.
        color: LANE_COLORS[pc % LANE_COLORS.length],
      });
    }
  }

  return { nodes, edges, cols: maxCols };
}

const colX = (col: number) => PAD_X + col * COL_W;
const rowY = (row: number) => row * ROW_H + ROW_H / 2;

function edgePath(e: Edge): string {
  const x1 = colX(e.fromCol);
  const y1 = rowY(e.fromRow);
  const x2 = colX(e.toCol);
  const y2 = rowY(e.toRow);
  if (e.fromCol === e.toCol) return `M${x1} ${y1}L${x2} ${y2}`;
  // Curve across to the parent's lane within the first row, then drop straight.
  const yb = y1 + ROW_H;
  return `M${x1} ${y1}C${x1} ${y1 + ROW_H / 2} ${x2} ${yb - ROW_H / 2} ${x2} ${yb}L${x2} ${y2}`;
}

interface Props {
  project: Project;
  /** Bumped by the parent to force a reload (e.g. after a branch action). */
  refreshKey?: number;
  /** Called after this view mutates git (so the refs sidebar refreshes too). */
  onChanged?: () => void;
  notify?: (kind: "ok" | "err", message: string) => void;
}

export default function CommitGraph({ project, refreshKey = 0, onChanged, notify }: Props) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // "Create branch here" inline state (in the detail pane).
  const [branching, setBranching] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);

  const load = useMemo(
    () => () => {
      setLoading(true);
      setError("");
      gitLog(project.path, 300)
        .then((c) => {
          setCommits(c);
          setSelected((cur) => cur ?? c[0]?.hash ?? null);
        })
        .catch((e) => setError(typeof e === "string" ? e : String(e)))
        .finally(() => setLoading(false));
    },
    [project.path]
  );

  useEffect(() => {
    setCommits(null);
    setSelected(null);
    setBranching(false);
    load();
    // refreshKey forces a reload after external git changes.
  }, [load, refreshKey]);

  async function createBranchHere(hash: string) {
    const name = branchName.trim();
    if (!name) return;
    setBranchBusy(true);
    try {
      await gitCreateBranch(project.path, name, hash, true);
      notify?.("ok", `Created and switched to ${name}.`);
      setBranching(false);
      setBranchName("");
      onChanged?.();
      load();
    } catch (e) {
      notify?.("err", typeof e === "string" ? e : String(e));
    } finally {
      setBranchBusy(false);
    }
  }

  const graph = useMemo(() => (commits ? layout(commits) : null), [commits]);
  const sel = commits?.find((c) => c.hash === selected) ?? null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-600">
        <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Reading history…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-500">
        <GitCommitIcon className="h-6 w-6 text-slate-600" />
        <p>{error}</p>
      </div>
    );
  }
  if (!commits || commits.length === 0 || !graph) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-600">
        No commits yet.
      </div>
    );
  }

  const svgW = colX(graph.cols) + COL_W / 2;
  const svgH = commits.length * ROW_H;

  return (
    <div className="flex h-full min-h-0">
      {/* Graph + rows */}
      <div className="min-w-0 flex-1 overflow-auto">
        <div className="relative" style={{ minWidth: "100%" }}>
          {/* Edge + node overlay */}
          <svg
            width={svgW}
            height={svgH}
            className="pointer-events-none absolute left-0 top-0"
            style={{ shapeRendering: "geometricPrecision" }}
          >
            {graph.edges.map((e, i) => (
              <path
                key={i}
                d={edgePath(e)}
                fill="none"
                stroke={e.color}
                strokeWidth={1.6}
                opacity={0.9}
              />
            ))}
            {graph.nodes.map((n) => {
              const color = LANE_COLORS[n.col % LANE_COLORS.length];
              const isSel = n.commit.hash === selected;
              return (
                <circle
                  key={n.commit.hash}
                  cx={colX(n.col)}
                  cy={rowY(n.row)}
                  r={isSel ? DOT_R + 1.5 : DOT_R}
                  fill={n.commit.isHead ? color : "#0b0f17"}
                  stroke={color}
                  strokeWidth={2}
                />
              );
            })}
          </svg>

          {/* Commit rows (text), padded past the graph gutter */}
          <ul style={{ paddingLeft: svgW }}>
            {graph.nodes.map((n) => {
              const c = n.commit;
              const isSel = c.hash === selected;
              return (
                <li
                  key={c.hash}
                  onClick={() => setSelected(c.hash)}
                  style={{ height: ROW_H }}
                  className={`flex cursor-pointer items-center gap-2 pr-3 text-xs ${
                    isSel ? "bg-accent/10" : "hover:bg-surface-hover"
                  }`}
                >
                  {c.refs.map((r) => (
                    <span
                      key={r}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        r === "HEAD"
                          ? "bg-emerald-400/15 text-emerald-300"
                          : r.startsWith("origin/") || r.startsWith("tag:")
                          ? "bg-slate-500/15 text-slate-400"
                          : "bg-accent/15 text-accent-soft"
                      }`}
                    >
                      {r.replace(/^tag: /, "⌗ ")}
                    </span>
                  ))}
                  <span className="min-w-0 flex-1 truncate text-slate-200">
                    {c.subject || "(no message)"}
                  </span>
                  <span className="hidden shrink-0 text-slate-500 sm:inline">
                    {c.author}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-600">
                    {c.shortHash}
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-600">
                    {c.dateRelative}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Detail pane */}
      <div className="hidden w-72 shrink-0 flex-col overflow-auto border-l border-surface-border bg-surface-base/40 p-4 lg:flex">
        {sel ? (
          <>
            <p className="mb-2 break-words text-sm font-medium text-slate-100">
              {sel.subject || "(no message)"}
            </p>
            {sel.body && (
              <pre className="mb-3 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-slate-400">
                {sel.body}
              </pre>
            )}
            <dl className="space-y-2 text-xs">
              <Detail label="Commit" value={sel.shortHash} mono />
              <Detail label="Author" value={`${sel.author} <${sel.email}>`} />
              <Detail
                label="Date"
                value={`${new Date(sel.dateIso).toLocaleString()} · ${sel.dateRelative}`}
              />
              <Detail
                label="Parents"
                value={sel.parents.length ? sel.parents.map((p) => p.slice(0, 7)).join(", ") : "(root)"}
                mono
              />
              {sel.refs.length > 0 && (
                <Detail label="Refs" value={sel.refs.join(", ")} />
              )}
            </dl>

            {/* Create branch at this commit */}
            <div className="mt-4 border-t border-surface-border pt-3">
              {branching ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createBranchHere(sel.hash);
                      if (e.key === "Escape") {
                        setBranching(false);
                        setBranchName("");
                      }
                    }}
                    placeholder="new-branch-name"
                    spellCheck={false}
                    className="w-full rounded-lg border border-accent/60 bg-surface-base px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none placeholder:text-slate-600"
                  />
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => createBranchHere(sel.hash)}
                    disabled={branchBusy || !branchName.trim()}
                    className="shrink-0 rounded-lg bg-accent p-1.5 text-white hover:bg-accent-glow disabled:opacity-40"
                  >
                    <CheckIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setBranching(false);
                      setBranchName("");
                    }}
                    className="shrink-0 rounded-lg border border-surface-border p-1.5 text-slate-400 hover:bg-surface-hover"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setBranching(true);
                    setBranchName("");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
                >
                  <GitBranchIcon className="h-3.5 w-3.5" />
                  Create branch here
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-600">Select a commit.</p>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">
        {label}
      </dt>
      <dd className={`mt-0.5 break-words text-slate-300 ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
