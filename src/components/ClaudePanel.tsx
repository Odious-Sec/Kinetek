import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ClaudeMode } from "../lib/tauri";
import type { Prerequisite, Project } from "../types";
import {
  checkTool,
  gitChanges,
  gitStatus,
  isTauri,
  openUrl,
  runClaudeAgent,
  stopClaude,
} from "../lib/tauri";
import Markdown from "./Markdown";
import {
  AlertIcon,
  BotIcon,
  ExternalLinkIcon,
  PlayIcon,
  RefreshIcon,
  XIcon,
} from "./icons";

interface Props {
  project: Project;
  notify: (kind: "ok" | "err", message: string) => void;
}

type Line = { line: string; stream: string };

interface Parsed {
  text: string;
  steps: string[];
}

/** Summarize a tool_use block into a short, human activity line. */
function formatTool(b: { name?: string; input?: Record<string, unknown> }): string {
  const name = b.name ?? "tool";
  const inp = b.input ?? {};
  const f = (inp.file_path ?? inp.path ?? "") as string;
  switch (name) {
    case "Bash":
      return `$ ${(inp.command as string) ?? ""}`;
    case "Edit":
    case "Write":
      return `✎ ${f}`;
    case "Read":
      return `↳ read ${f}`;
    case "Grep":
      return `⌕ ${(inp.pattern as string) ?? ""}`;
    case "Glob":
      return `⌕ ${(inp.pattern as string) ?? ""}`;
    case "TodoWrite":
      return "• updated plan";
    default:
      return name;
  }
}

/** Parse Claude Code's stream-json (NDJSON) output into answer text + activity. */
function parseStream(lines: Line[]): Parsed {
  let text = "";
  const steps: string[] = [];
  for (const l of lines) {
    if (l.stream === "stderr") continue;
    const raw = l.line.trim();
    if (!raw) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw);
    } catch {
      // Not JSON (older CLI / plain text) — show it verbatim.
      text += (text ? "\n" : "") + l.line;
      continue;
    }
    const type = ev.type as string;
    if (type === "assistant") {
      const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === "text") text += (block.text as string) ?? "";
        else if (block.type === "tool_use") steps.push(formatTool(block));
      }
    } else if (type === "result") {
      const result = ev.result as string | undefined;
      if (!text.trim() && typeof result === "string") text = result;
    }
  }
  return { text, steps };
}

/** Build a compact snapshot of what the user is looking at in Kinetek, so the
 *  agent has the app's context (not just the files on disk). */
async function buildSnapshot(project: Project): Promise<string> {
  const [st, changes] = await Promise.all([
    gitStatus(project.path).catch(() => null),
    gitChanges(project.path).catch(() => []),
  ]);
  const lines = [
    "<kinetek-context>",
    "The user triggered this from Kinetek (their project control center). Current view:",
    `- Project: ${project.name}`,
    `- Path: ${project.path}`,
    `- Status: ${project.status}`,
  ];
  if (project.frameworks.length) lines.push(`- Stack: ${project.frameworks.join(", ")}`);
  if (project.summary) lines.push(`- Summary: ${project.summary}`);
  if (st) {
    lines.push(`- Git: branch ${st.branch}${st.dirty ? " (uncommitted changes)" : " (clean)"}${st.ahead ? `, ${st.ahead} ahead` : ""}${st.behind ? `, ${st.behind} behind` : ""}`);
  }
  if (changes.length) {
    lines.push(`- Uncommitted (${changes.length}):`);
    for (const c of changes.slice(0, 25)) lines.push(`    ${c.status}: ${c.path}`);
    if (changes.length > 25) lines.push(`    …and ${changes.length - 25} more`);
  }
  lines.push("</kinetek-context>");
  return lines.join("\n");
}

const MODES: { id: ClaudeMode; label: string; hint: string }[] = [
  { id: "plan", label: "Plan (read-only)", hint: "Explores and answers — won't change files." },
  { id: "acceptEdits", label: "Auto-edit", hint: "Lets Claude Code make file changes in this project." },
];

/**
 * Delegate a task to the installed Claude Code CLI, running in this project's
 * directory (so it has full project context) with a Kinetek state snapshot
 * injected. Output streams live. Uses the user's own Claude Code auth — Kinetek
 * stores no key for this.
 */
export default function ClaudePanel({ project, notify }: Props) {
  const [avail, setAvail] = useState<Prerequisite | null | "loading">("loading");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<ClaudeMode>("plan");
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);

  const runIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setAvail(null);
      return;
    }
    checkTool("claude")
      .then(setAvail)
      .catch(() => setAvail(null));
  }, []);

  // Tear down listeners on unmount / project change.
  useEffect(() => {
    return () => {
      unlistenRef.current.forEach((u) => u());
      unlistenRef.current = [];
    };
  }, [project.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  function cleanupListeners() {
    unlistenRef.current.forEach((u) => u());
    unlistenRef.current = [];
  }

  async function run() {
    if (!prompt.trim() || running) return;
    const id = `claude-${Date.now()}`;
    runIdRef.current = id;
    setLines([]);
    setRunning(true);

    const onOut = await listen<{ runId: string; line: string; stream: string }>(
      "claude-output",
      (e) => {
        if (e.payload.runId !== id) return;
        setLines((prev) => [...prev.slice(-4000), { line: e.payload.line, stream: e.payload.stream }]);
      }
    );
    unlistenRef.current.push(onOut);

    try {
      const snapshot = await buildSnapshot(project);
      const full = `${snapshot}\n\n${prompt.trim()}`;
      await runClaudeAgent(id, project.path, full, mode);
      notify("ok", "Claude Code finished.");
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setRunning(false);
      cleanupListeners();
    }
  }

  async function stop() {
    if (runIdRef.current) {
      try {
        await stopClaude(runIdRef.current);
        notify("ok", "Stopped Claude Code.");
      } catch {
        /* best effort */
      }
    }
  }

  const parsed = useMemo(() => parseStream(lines), [lines]);
  const stderrLines = lines.filter((l) => l.stream === "stderr").map((l) => l.line);

  if (avail === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-600">
        <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Checking for Claude Code…
      </div>
    );
  }

  if (!avail || !avail.installed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-accent/15 text-accent-soft">
          <BotIcon className="h-6 w-6" />
        </span>
        <h3 className="text-sm font-semibold text-slate-100">Claude Code isn't installed</h3>
        <p className="max-w-sm text-xs leading-relaxed text-slate-400">
          Kinetek can delegate coding tasks to the Claude Code CLI running in this
          project — using your own Claude Code sign-in. Install it, then reopen
          this tab.
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded-md bg-surface-card px-2 py-1 font-mono text-[11px] text-slate-300">
            npm i -g @anthropic-ai/claude-code
          </code>
          <button
            onClick={() => openUrl("https://docs.anthropic.com/en/docs/claude-code/setup")}
            className="inline-flex items-center gap-1 text-xs text-accent-soft hover:underline"
          >
            Setup guide <ExternalLinkIcon className="h-3 w-3" />
          </button>
        </div>
        <button
          onClick={() => {
            setAvail("loading");
            checkTool("claude").then(setAvail).catch(() => setAvail(null));
          }}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-surface-hover"
        >
          <RefreshIcon className="h-3.5 w-3.5" /> Re-check
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Prompt + controls */}
      <div className="shrink-0 border-b border-surface-border p-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
          <BotIcon className="h-4 w-4 text-accent-soft" />
          <span className="text-slate-300">Claude Code</span>
          <span className="text-slate-600">· runs in this project · uses your Claude sign-in</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          disabled={running}
          placeholder="Ask Claude Code to do something in this project — e.g. “add input validation to the signup form” or “explain how auth works”."
          className="w-full resize-y rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60 disabled:opacity-60"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Mode */}
          <div className="flex items-center gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                disabled={running}
                title={m.hint}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  mode === m.id
                    ? "border-accent/60 bg-accent/15 text-accent-soft"
                    : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <button
                onClick={stop}
                className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-surface-hover"
              >
                <XIcon className="h-3.5 w-3.5" /> Stop
              </button>
            ) : null}
            <button
              onClick={run}
              disabled={running || !prompt.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> : <PlayIcon className="h-3.5 w-3.5" />}
              {running ? "Running…" : "Run"}
            </button>
          </div>
        </div>
        {mode === "acceptEdits" && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300/90">
            <AlertIcon className="h-3.5 w-3.5 shrink-0" />
            Auto-edit lets Claude Code modify files in this project. Review changes in the Source-control tab afterwards.
          </p>
        )}
      </div>

      {/* Streamed output — rendered as Markdown (headings, lists, highlighted code) */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-base" data-selectable="true">
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-xs text-slate-600">
            {running ? (
              <>
                <span className="relative grid h-10 w-10 place-items-center">
                  <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent/30" />
                  <BotIcon className="relative h-5 w-5 text-accent-soft" />
                </span>
                Claude is working…
              </>
            ) : (
              <>
                <BotIcon className="h-6 w-6 text-slate-700" />
                Ask Claude Code to do something — its response shows here.
              </>
            )}
          </div>
        ) : (
          <div className="p-4">
            {parsed.steps.length > 0 && (
              <div className="mb-3 space-y-0.5 rounded-lg border border-surface-border bg-surface-card/60 p-2">
                {parsed.steps.map((s, i) => (
                  <div key={i} className="truncate font-mono text-[11px] text-slate-500" title={s}>
                    {s}
                  </div>
                ))}
              </div>
            )}
            {parsed.text.trim() && <Markdown content={parsed.text} />}
            {stderrLines.length > 0 && (
              <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-surface-border bg-surface-card p-2.5 font-mono text-[11px] leading-relaxed text-amber-300/80">
                {stderrLines.join("\n")}
              </pre>
            )}
            {running && (
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> working…
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </div>
  );
}
