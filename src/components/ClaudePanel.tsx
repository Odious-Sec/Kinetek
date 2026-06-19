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
  PlusIcon,
  RefreshIcon,
  SparkIcon,
  UserIcon,
  XIcon,
} from "./icons";

/** Preset prompt: generate context docs (CLAUDE.md + README) per part + root. */
const DOCS_PROMPT = `Create context documentation for this project so a developer or an AI agent has full context BEFORE opening it in an IDE.

For the project root, and for each of these subfolders that actually exists — \`app/\` and \`api/\` — write BOTH files:
- \`CLAUDE.md\`: concise, agent-oriented context — what this part is, its tech stack, how it's structured, how to run/build/test it, and the key files/entry points. Write it the way a senior engineer would brief an AI agent picking up the code.
- \`README.md\`: a clear, human-readable version of the same.

Rules:
- Inspect the ACTUAL files first — describe what's really there, don't invent or assume.
- Skip a subfolder if it doesn't exist (e.g. no \`api/\` → no api docs).
- The root \`CLAUDE.md\`/\`README.md\` should tie the parts together: what the whole project is and how app / api / database relate.
- Only CREATE or overwrite these Markdown files — do not modify any source code.
- Keep each file focused and accurate.`;

/** Preset prompt: sync the app↔API contract so each side knows the other. */
const CONTRACT_PROMPT = `Sync this project's app and API so each side has accurate, up-to-date context about the other.

1. Inspect \`api/\` and document the REAL contract it exposes — for every endpoint: method, path, request body/params, response shape, and auth. Inspect \`app/\` to see which of those endpoints it actually calls.
2. Write or refresh a single \`CONTRACT.md\` at the project ROOT capturing that contract (the API is the source of truth). Flag any mismatches — app calls to a route the API doesn't expose, or endpoints the app never uses.
3. Update \`app/CLAUDE.md\` so it states the app consumes the API defined in \`../CONTRACT.md\` and must follow it. Update \`api/CLAUDE.md\` so it states the API must honor \`../CONTRACT.md\` because the app depends on it. Create these files if missing.

Only create/edit Markdown files — do NOT change any source code. Be accurate to the actual code you find.`;

interface Props {
  project: Project;
  notify: (kind: "ok" | "err", message: string) => void;
}

type Line = { line: string; stream: string };

/** A single turn in the conversation. `label` (optional) is shown instead of the
 *  full prompt for preset actions; `steps` are the tool-activity lines. */
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  steps: string[];
  label?: string;
}

interface Parsed {
  text: string;
  steps: string[];
  sessionId?: string;
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

/** Parse Claude Code's stream-json (NDJSON) output into answer text + activity,
 *  capturing the session id (from the `init`/`result` events) so follow-up
 *  turns can `--resume` the same conversation. */
function parseStream(lines: Line[]): Parsed {
  let text = "";
  let sessionId: string | undefined;
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
    if (typeof ev.session_id === "string") sessionId = ev.session_id;
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
  return { text, steps, sessionId };
}

/** Build a compact snapshot of what the user is looking at in Kinetek, so the
 *  agent has the app's context (not just the files on disk). Injected only on
 *  the FIRST message of a session; follow-ups rely on session memory. */
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

/** Render one assistant turn (activity steps + Markdown answer). */
function AssistantBubble({ text, steps }: { text: string; steps: string[] }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-accent-soft">
        <BotIcon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {steps.length > 0 && (
          <div className="mb-2 space-y-0.5 rounded-lg border border-surface-border bg-surface-card/60 p-2">
            {steps.map((s, i) => (
              <div key={i} className="truncate font-mono text-[11px] text-slate-500" title={s}>
                {s}
              </div>
            ))}
          </div>
        )}
        {text.trim() ? (
          <Markdown content={text} />
        ) : (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> working…
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Multi-turn chat with the installed Claude Code CLI, running in this project's
 * directory (so it has full project context). The first message injects a
 * Kinetek state snapshot; follow-ups `--resume` the same Claude Code session so
 * the conversation keeps its memory. Uses the user's own Claude Code auth.
 */
export default function ClaudePanel({ project, notify }: Props) {
  const [avail, setAvail] = useState<Prerequisite | null | "loading">("loading");
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ClaudeMode>("plan");
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Live streaming buffer for the in-progress assistant turn.
  const [lines, setLines] = useState<Line[]>([]);

  const runIdRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  // Mirror of `lines` so the finally block can read the final buffer synchronously.
  const linesRef = useRef<Line[]>([]);
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

  // Switching projects starts a fresh conversation (a session is project-scoped).
  useEffect(() => {
    cleanupListeners();
    sessionRef.current = null;
    linesRef.current = [];
    setMessages([]);
    setLines([]);
  }, [project.id]);

  // Tear down listeners on unmount.
  useEffect(() => {
    return () => cleanupListeners();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, lines]);

  function cleanupListeners() {
    unlistenRef.current.forEach((u) => u());
    unlistenRef.current = [];
  }

  /** Send a turn. `label` shows a short chip instead of the (full) prompt. */
  async function send(promptText: string, runMode: ClaudeMode, label?: string) {
    if (!promptText.trim() || running) return;
    const id = `claude-${Date.now()}`;
    runIdRef.current = id;
    setInput("");
    linesRef.current = [];
    setLines([]);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: promptText.trim(), steps: [], label },
      { role: "assistant", text: "", steps: [] },
    ]);
    setRunning(true);

    const onOut = await listen<{ runId: string; line: string; stream: string }>(
      "claude-output",
      (e) => {
        if (e.payload.runId !== id) return;
        const line = { line: e.payload.line, stream: e.payload.stream };
        linesRef.current = [...linesRef.current.slice(-4000), line];
        setLines(linesRef.current);
        // Capture the session id as soon as it appears so follow-ups resume it.
        if (!sessionRef.current && e.payload.stream !== "stderr") {
          try {
            const ev = JSON.parse(e.payload.line.trim());
            if (typeof ev.session_id === "string") sessionRef.current = ev.session_id;
          } catch {
            /* not a JSON line */
          }
        }
      }
    );
    unlistenRef.current.push(onOut);

    // Inject the Kinetek snapshot only on the first message of the session.
    const isFirst = !sessionRef.current;
    try {
      const full = isFirst
        ? `${await buildSnapshot(project)}\n\n${promptText.trim()}`
        : promptText.trim();
      await runClaudeAgent(id, project.path, full, runMode, sessionRef.current ?? undefined);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setRunning(false);
      cleanupListeners();
      // Commit the streamed turn into the assistant message so it persists,
      // then clear the live buffer.
      const parsed = parseStream(linesRef.current);
      if (parsed.sessionId) sessionRef.current = parsed.sessionId;
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === "assistant") {
            next[i] = { ...next[i], text: parsed.text, steps: parsed.steps };
            break;
          }
        }
        return next;
      });
      linesRef.current = [];
      setLines([]);
    }
  }

  function onSubmit() {
    void send(input, mode);
  }

  // Preset actions become messages in the conversation (short label shown, full
  // prompt sent). Both write files, so they force auto-edit.
  function runDocs() {
    if (running) return;
    void send(DOCS_PROMPT, "acceptEdits", "Generate context docs");
  }
  function runContract() {
    if (running) return;
    void send(CONTRACT_PROMPT, "acceptEdits", "Sync API contract");
  }

  function newChat() {
    if (running) return;
    sessionRef.current = null;
    linesRef.current = [];
    setMessages([]);
    setLines([]);
    setInput("");
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

  const live = useMemo(() => parseStream(lines), [lines]);
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

  const empty = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-3 py-2 text-xs text-slate-500">
        <BotIcon className="h-4 w-4 text-accent-soft" />
        <span className="text-slate-300">Claude Code</span>
        <span className="hidden text-slate-600 sm:inline">· chat · uses your Claude sign-in</span>
        <button
          onClick={newChat}
          disabled={running || empty}
          title="Start a new conversation (clears history)"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" /> New chat
        </button>
      </div>

      {/* Conversation */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-base" data-selectable="true">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-xs text-slate-600">
            <BotIcon className="h-6 w-6 text-slate-700" />
            <p className="max-w-xs leading-relaxed">
              Chat with Claude Code in this project. It remembers the conversation —
              ask a follow-up and it keeps context.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                onClick={runDocs}
                title="Have Claude Code write CLAUDE.md + README for app / api / root"
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent-soft transition-colors hover:bg-accent/15"
              >
                <SparkIcon className="h-3.5 w-3.5" /> Generate context docs
              </button>
              <button
                onClick={runContract}
                title="Sync app↔API: write CONTRACT.md and point both CLAUDE.md files at it"
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent-soft transition-colors hover:bg-accent/15"
              >
                <SparkIcon className="h-3.5 w-3.5" /> Sync API contract
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {messages.map((m, i) => {
              const isLastAssistant =
                m.role === "assistant" && i === messages.length - 1 && running;
              if (m.role === "user") {
                return (
                  <div key={i} className="flex justify-end gap-2.5">
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-accent/15 px-3 py-2 text-sm text-slate-100">
                      {m.label ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-accent-soft">
                          <SparkIcon className="h-3.5 w-3.5" /> {m.label}
                        </span>
                      ) : (
                        <span className="whitespace-pre-wrap break-words">{m.text}</span>
                      )}
                    </div>
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-card text-slate-400">
                      <UserIcon className="h-3.5 w-3.5" />
                    </span>
                  </div>
                );
              }
              // Assistant: the streaming turn renders from the live buffer.
              return (
                <AssistantBubble
                  key={i}
                  text={isLastAssistant ? live.text : m.text}
                  steps={isLastAssistant ? live.steps : m.steps}
                />
              );
            })}
            {running && stderrLines.length > 0 && (
              <pre className="ml-8 whitespace-pre-wrap break-words rounded-lg border border-surface-border bg-surface-card p-2.5 font-mono text-[11px] leading-relaxed text-amber-300/80">
                {stderrLines.join("\n")}
              </pre>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-surface-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          disabled={running}
          placeholder={
            sessionRef.current
              ? "Reply to Claude Code… (Enter to send, Shift+Enter for newline)"
              : "Ask Claude Code to do something in this project…"
          }
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
              onClick={onSubmit}
              disabled={running || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> : <SparkIcon className="h-3.5 w-3.5" />}
              {running ? "Working…" : "Send"}
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
    </div>
  );
}
