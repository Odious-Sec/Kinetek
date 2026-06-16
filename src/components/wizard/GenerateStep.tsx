import { useEffect, useState } from "react";
import type { GeneratedFile, Project, Purpose } from "../../types";
import { AI_PROVIDERS, secretKeyFor } from "../../lib/ai";
import { generateFiles, IMPLEMENTED_PROVIDERS } from "../../lib/generate";
import { getSecret, logError, openUrl, writeGeneratedFiles } from "../../lib/tauri";
import {
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  KeyIcon,
  RefreshIcon,
  SparkIcon,
} from "../icons";

type GenPhase = "idle" | "generating" | "preview" | "applying" | "applied" | "error";

/**
 * Goal-first final step: configure a BYOK provider, generate a starter file set
 * from the composed prompt, preview it, and write it into the project on Apply.
 */
export default function GenerateStep({
  project,
  purpose,
  prompt,
}: {
  project: Project;
  purpose: Purpose;
  prompt: string;
}) {
  const [genPhase, setGenPhase] = useState<GenPhase>("idle");
  const [providerId, setProviderId] = useState(AI_PROVIDERS[0].id);
  const [apiKey, setApiKey] = useState("");
  const [editedPrompt, setEditedPrompt] = useState(prompt);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [openFile, setOpenFile] = useState<number | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const provider = AI_PROVIDERS.find((p) => p.id === providerId) ?? AI_PROVIDERS[0];
  const implemented = IMPLEMENTED_PROVIDERS.has(provider.id);
  const canGenerate = implemented && apiKey.trim().length > 0;

  // Prefill the key from the OS keychain (set in Settings) for this provider.
  useEffect(() => {
    let cancelled = false;
    getSecret(secretKeyFor(providerId))
      .then((k) => {
        if (!cancelled) setApiKey(k ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  async function handleGenerate() {
    setGenPhase("generating");
    setErrorMsg("");
    setOpenFile(null);
    try {
      const result = await generateFiles(provider, apiKey, editedPrompt);
      setFiles(result);
      setGenPhase("preview");
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      void logError(`generate:${provider.id}`, msg);
      setGenPhase("error");
    }
  }

  async function handleApply() {
    setGenPhase("applying");
    setErrorMsg("");
    try {
      const count = await writeGeneratedFiles(project.path, files);
      setAppliedCount(count);
      setGenPhase("applied");
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      void logError("apply-files", msg);
      setGenPhase("error");
    }
  }

  /* ----- transient states ----- */
  if (genPhase === "generating" || genPhase === "applying") {
    const applying = genPhase === "applying";
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <RefreshIcon className="h-7 w-7 animate-spin text-accent-soft" />
        <h3 className="mt-4 text-sm font-semibold text-slate-100">
          {applying ? `Writing ${files.length} files…` : `Asking ${provider.name} to draft your starter…`}
        </h3>
        <p className="mt-1.5 max-w-sm text-xs text-slate-400">
          {applying
            ? "Saving the generated files into your project folder."
            : "This usually takes a few seconds — Gemini is generating the starter files."}
        </p>
      </div>
    );
  }

  if (genPhase === "error") {
    return (
      <div className="flex flex-col items-center py-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30">
          <AlertIcon className="h-6 w-6" />
        </span>
        <h3 className="mt-3 text-sm font-semibold text-slate-100">Generation failed</h3>
        <pre
          data-selectable="true"
          className="mt-3 max-h-40 w-full overflow-auto whitespace-pre-wrap rounded-lg border border-surface-border bg-surface-base p-3 text-left font-mono text-xs leading-relaxed text-rose-200/90"
        >
          {errorMsg}
        </pre>
        <p className="mt-2 text-[11px] text-slate-500">
          Also saved to <span className="font-mono">kinetek-errors.log</span> in the project root.
        </p>
        <button
          onClick={() => setGenPhase(files.length ? "preview" : "idle")}
          className="mt-4 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-slate-200 hover:bg-surface-hover"
        >
          Back
        </button>
      </div>
    );
  }

  if (genPhase === "applied") {
    return (
      <div className="flex flex-col items-center py-10 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30 animate-scale-in">
          <CheckCircleIcon className="h-7 w-7" />
        </span>
        <h3 className="mt-4 text-base font-semibold text-slate-100">
          Wrote {appliedCount} file{appliedCount === 1 ? "" : "s"}
        </h3>
        <p className="mt-1 max-w-sm text-sm text-slate-400">
          Your {purpose.name.toLowerCase()} starter is in the project. Open it in
          your editor to keep building.
        </p>
        <div className="mt-4 w-full space-y-1 text-left">
          {files.map((f) => (
            <div
              key={f.path}
              className="flex items-center gap-2 truncate rounded-md bg-surface-card px-2 py-1 font-mono text-[11px] text-slate-400"
            >
              <CheckIcon className="h-3 w-3 shrink-0 text-emerald-300" />
              {f.path}
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ----- preview ----- */
  if (genPhase === "preview") {
    return (
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-300">
            <span className="font-medium text-slate-100">{files.length} files</span>{" "}
            proposed — review, then apply.
          </p>
          <button
            onClick={handleGenerate}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <RefreshIcon className="h-3.5 w-3.5" />
            Regenerate
          </button>
        </div>

        <div className="space-y-1.5">
          {files.map((f, i) => (
            <div
              key={f.path}
              className="overflow-hidden rounded-xl border border-surface-border bg-surface-card"
            >
              <button
                onClick={() => setOpenFile(openFile === i ? null : i)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-hover"
              >
                <FileIcon className="h-4 w-4 shrink-0 text-accent-soft" />
                <span className="flex-1 truncate font-mono text-xs text-slate-200">
                  {f.path}
                </span>
                <span className="shrink-0 text-[10px] text-slate-500">
                  {f.contents.split("\n").length} lines
                </span>
              </button>
              {openFile === i && (
                <pre
                  data-selectable="true"
                  className="max-h-64 overflow-auto border-t border-surface-border bg-surface-base p-3 font-mono text-[11px] leading-relaxed text-slate-300"
                >
                  {f.contents}
                </pre>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleApply}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
          >
            <DownloadIcon className="h-4 w-4" />
            Apply {files.length} file{files.length === 1 ? "" : "s"}
          </button>
          <button
            onClick={() => {
              setFiles([]);
              setGenPhase("idle");
            }}
            className="rounded-lg border border-surface-border bg-surface-card px-4 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
          >
            Discard
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          Files are written only into{" "}
          <span className="font-mono">{project.name}</span> when you click Apply.
        </p>
      </div>
    );
  }

  /* ----- idle (configure + generate) ----- */
  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center gap-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-400/20 text-emerald-300">
          <CheckIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-100">
            {project.name} scaffolded
          </p>
          <p className="truncate text-xs text-slate-400">
            Now generate a {purpose.name.toLowerCase()} starter on top of it.
          </p>
        </div>
      </div>

      {/* Provider (BYOK) */}
      <div>
        <span className="mb-1.5 block text-xs font-medium text-slate-400">
          AI provider (bring your own key)
        </span>
        <div className="flex flex-wrap gap-2">
          {AI_PROVIDERS.map((p) => {
            const ready = IMPLEMENTED_PROVIDERS.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => setProviderId(p.id)}
                disabled={!ready}
                title={ready ? undefined : "Coming soon"}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  providerId === p.id
                    ? "border-accent/60 bg-accent/15 text-accent-soft"
                    : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
                }`}
              >
                {p.name}
                {p.free && (
                  <span className="rounded bg-emerald-400/15 px-1 py-0.5 text-[10px] font-semibold text-emerald-300">
                    Free
                  </span>
                )}
                {!ready && (
                  <span className="rounded bg-surface-raised px-1 py-0.5 text-[10px] font-medium text-slate-500">
                    soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {provider.note}{" "}
          <button
            onClick={() => openUrl(provider.keyUrl)}
            className="inline-flex items-center gap-0.5 text-accent-soft hover:underline"
          >
            Get a key <ExternalLinkIcon className="h-3 w-3" />
          </button>
        </p>
      </div>

      {/* API key (prefilled from keychain if saved) */}
      <div>
        <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <KeyIcon className="h-3.5 w-3.5" /> {provider.name} API key
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste your key…"
          spellCheck={false}
          className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60"
        />
        <p className="mt-1.5 text-[11px] text-slate-500">
          Prefilled from your saved key (Settings) when available; stored only in the OS keychain.
        </p>
      </div>

      {/* Composed prompt */}
      <div>
        <span className="mb-1.5 block text-xs font-medium text-slate-400">
          Starter prompt (editable)
        </span>
        <textarea
          value={editedPrompt}
          onChange={(e) => setEditedPrompt(e.target.value)}
          rows={7}
          spellCheck={false}
          data-selectable="true"
          className="w-full resize-y rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-xs leading-relaxed text-slate-200 outline-none transition-colors focus:border-accent/60"
        />
      </div>

      <button
        onClick={handleGenerate}
        disabled={!canGenerate}
        title={!apiKey.trim() ? "Paste your API key first." : undefined}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
      >
        <SparkIcon className="h-4 w-4" />
        Generate starter
      </button>
    </div>
  );
}
