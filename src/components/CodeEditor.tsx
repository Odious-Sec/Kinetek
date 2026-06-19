import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { monaco } from "../lib/monaco";
import type { DirEntry } from "../types";
import { checkSyntax, readFileText, writeFileText } from "../lib/tauri";
import { shortcut } from "../lib/platform";
import { ExternalLinkIcon, FileIcon, RefreshIcon } from "./icons";

/** File extension → Monaco language id. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json",
  html: "html", htm: "html", vue: "html",
  css: "css", scss: "scss", less: "less",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", rb: "ruby", swift: "swift", sh: "shell", bash: "shell", zsh: "shell",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  md: "markdown", markdown: "markdown", sql: "sql", xml: "xml", svg: "xml",
  dockerfile: "dockerfile", lua: "lua", r: "r",
};

function langFor(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  return EXT_LANG[ext] ?? "plaintext";
}

/**
 * In-app code editor (Monaco). Edit + save real files, with live diagnostics for
 * web languages (Monaco's built-in services) and on-save backend syntax checks
 * for Python/Go surfaced as the same gutter squiggles. Lazy-loaded so Monaco
 * stays out of the startup bundle.
 */
export default function CodeEditor({
  entry,
  onReveal,
  notify,
}: {
  entry: DirEntry;
  onReveal: (entry: DirEntry) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<"ok" | "binary" | "tooLarge">("ok");
  const [saving, setSaving] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  const dirty = value !== original;
  const language = langFor(entry.name);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setState("ok");
    readFileText(entry.path)
      .then((d) => {
        if (cancelled) return;
        if (d.binary) setState("binary");
        else if (d.tooLarge) setState("tooLarge");
        else {
          setValue(d.content);
          setOriginal(d.content);
        }
      })
      .catch((e) => notify("err", typeof e === "string" ? e : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [entry.path, notify]);

  async function runDiagnostics() {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!model) return;
    try {
      const diags = await checkSyntax(entry.path);
      monaco.editor.setModelMarkers(
        model,
        "kinetek",
        diags.map((d) => ({
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.line,
          endColumn: d.column + 1,
          message: d.message,
          severity:
            d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Error,
        }))
      );
    } catch {
      /* a failed check should never block editing */
    }
  }

  async function save() {
    const ed = editorRef.current;
    if (!ed || saving) return;
    const current = ed.getValue();
    if (current === original) return;
    setSaving(true);
    try {
      await writeFileText(entry.path, current);
      setOriginal(current);
      setValue(current);
      notify("ok", `Saved ${entry.name}.`);
      runDiagnostics();
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setSaving(false);
    }
  }

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save();
    });
    void runDiagnostics();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-3 py-2">
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">
          {entry.name}
          {dirty && <span className="ml-1.5 text-accent-soft" title="Unsaved changes">●</span>}
        </span>
        {state === "ok" && (
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-glow disabled:opacity-40"
          >
            {saving ? <RefreshIcon className="h-3 w-3 animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
            <span className="text-white/60">{shortcut("S")}</span>
          </button>
        )}
        <button
          onClick={() => onReveal(entry)}
          title="Open externally"
          className="shrink-0 rounded p-1 text-slate-500 hover:text-slate-200"
        >
          <ExternalLinkIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-600">
            <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : state === "binary" ? (
          <p className="p-4 text-xs text-slate-500">
            This looks like a binary file and can't be edited as text.
          </p>
        ) : state === "tooLarge" ? (
          <p className="p-4 text-xs text-slate-500">
            This file is large — open it externally to edit it.
          </p>
        ) : (
          <Editor
            theme="kinetek"
            language={language}
            value={value}
            onChange={(v) => setValue(v ?? "")}
            onMount={onMount}
            options={{
              fontFamily: "SFMono-Regular, ui-monospace, Menlo, Consolas, monospace",
              fontSize: 12.5,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: "selection",
              smoothScrolling: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
