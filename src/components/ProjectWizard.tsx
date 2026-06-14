import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Category,
  GeneratedFile,
  Prerequisite,
  Project,
  ProjectStatus,
  Purpose,
  Template,
  WizardMode,
} from "../types";
import { PROJECT_STATUSES } from "../types";
import { TEMPLATES, getTemplate } from "../lib/templates";
import { CATEGORIES, composePrompt } from "../lib/categories";
import { AI_PROVIDERS, secretKeyFor } from "../lib/ai";
import { generateFiles, IMPLEMENTED_PROVIDERS } from "../lib/generate";
import Field from "./Field";
import {
  checkPrerequisites,
  createProject,
  getSecret,
  installTool,
  isTauri,
  logError,
  openUrl,
  pickDirectory,
  writeGeneratedFiles,
} from "../lib/tauri";
import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CheckCircleIcon,
  CodeIcon,
  CompassIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  KeyIcon,
  LayersIcon,
  RefreshIcon,
  SparkIcon,
  TerminalIcon,
  XIcon,
} from "./icons";

type Phase =
  | "mode"
  | "category"
  | "purpose"
  | "template"
  | "details"
  | "preflight"
  | "running"
  | "generate"
  | "done"
  | "error";

interface Props {
  /** Prefill the project location (from Settings → default location). */
  defaultDir?: string;
  /** Called when the user closes the wizard without creating anything. */
  onClose: () => void;
  /** Called with the freshly created project so the dashboard can add it. */
  onCreated: (project: Project) => void;
  /** Open the new project directly in VS Code. */
  onOpenInCode: (project: Project) => void;
}

export default function ProjectWizard({
  defaultDir = "",
  onClose,
  onCreated,
  onOpenInCode,
}: Props) {
  const [phase, setPhase] = useState<Phase>("mode");
  const [mode, setMode] = useState<WizardMode | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState(defaultDir);
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("In Development");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Project | null>(null);

  // Goal-first ("Build by goal") state.
  const [category, setCategory] = useState<Category | null>(null);
  const [purpose, setPurpose] = useState<Purpose | null>(null);

  // Live build terminal.
  const [showTerminal, setShowTerminal] = useState(true);
  const [buildLines, setBuildLines] = useState<{ line: string; stream: string }[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Stop listening if the wizard unmounts mid-build.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  // Preflight (prerequisite) state.
  const [prereqs, setPrereqs] = useState<Prerequisite[]>([]);
  const [prereqLoading, setPrereqLoading] = useState(false);
  const [prereqError, setPrereqError] = useState("");
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});

  const stepLabels =
    mode === "goal"
      ? ["Goal", "Details", "Build", "AI starter"]
      : ["Template", "Details", "Build"];

  const stepIndex: number = (() => {
    switch (phase) {
      case "details":
      case "error":
        return 1;
      case "preflight":
      case "running":
        return 2;
      case "generate":
        return 3;
      case "done":
        return mode === "goal" ? 3 : 2;
      default: // mode / category / purpose / template
        return 0;
    }
  })();

  // The AI expansion prompt for the chosen goal (handed to the backend later).
  const goalPrompt = useMemo(
    () =>
      purpose && template ? composePrompt(purpose, name, template.name) : "",
    [purpose, template, name]
  );

  const nameIsValid = /^[a-zA-Z0-9._-]+$/.test(name.trim());
  const canBuild = !!template && nameIsValid && parentDir.trim().length > 0;
  const missingRequired = prereqs.filter((p) => p.required && !p.installed);
  const readyToBuild = !prereqLoading && !prereqError && missingRequired.length === 0;

  async function handlePickDir() {
    const dir = await pickDirectory();
    if (dir) setParentDir(dir);
  }

  const loadPrereqs = useCallback(async (templateId: string) => {
    setPrereqLoading(true);
    setPrereqError("");
    try {
      setPrereqs(await checkPrerequisites(templateId));
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setPrereqError(msg);
      void logError("preflight", msg);
    } finally {
      setPrereqLoading(false);
    }
  }, []);

  function handleSelectPurpose(p: Purpose) {
    setPurpose(p);
    const t = getTemplate(p.templateId) ?? null;
    setTemplate(t);
    // Prefill the plain-English summary; the user can still edit it.
    if (!summary.trim()) setSummary(p.summary);
    setPhase("details");
  }

  async function handleContinueToPreflight() {
    if (!template || !canBuild) return;
    // In a plain browser there's no backend to check — go straight to build,
    // which surfaces a clear "desktop only" error.
    if (!isTauri()) {
      handleBuild();
      return;
    }
    setPhase("preflight");
    loadPrereqs(template.id);
  }

  async function handleInstall(key: string) {
    setInstalling((m) => ({ ...m, [key]: true }));
    setInstallErrors((m) => ({ ...m, [key]: "" }));
    try {
      await installTool(key);
      if (template) await loadPrereqs(template.id);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setInstallErrors((m) => ({ ...m, [key]: msg }));
      void logError(`install:${key}`, msg);
    } finally {
      setInstalling((m) => ({ ...m, [key]: false }));
    }
  }

  async function handleBuild() {
    if (!template || !canBuild) return;
    setError("");
    setBuildLines([]);

    // Attach the live-output listener BEFORE invoking, so no early lines are
    // missed. (Only when the user opted to see the terminal.)
    if (isTauri() && showTerminal) {
      unlistenRef.current = await listen<{ line: string; stream: string }>(
        "project-output",
        (e) => setBuildLines((prev) => [...prev.slice(-800), e.payload])
      );
    }

    setPhase("running");
    try {
      const project = await createProject({
        parentDir,
        projectName: name.trim(),
        templateId: template.id,
        summary:
          summary.trim() ||
          `A new ${template.name} project, ready to be developed.`,
        status,
        frameworks: template.frameworks,
      });
      setCreated(project);
      onCreated(project);
      // Goal-first projects get an extra AI "expand into a starter" step.
      setPhase(mode === "goal" ? "generate" : "done");
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setError(msg);
      void logError(`scaffold:${template.id}`, msg);
      setPhase("error");
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={phase === "running" ? undefined : onClose}
      />

      {/* Panel */}
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface-raised shadow-glow animate-scale-in">
        {/* Header + stepper */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/20 text-accent-soft">
              <SparkIcon className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                New Project
              </h2>
              <p className="text-xs text-slate-500">Bootstrap a template in seconds</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={phase === "running"}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200 disabled:opacity-30"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Stepper (hidden on the mode chooser, before a path is picked) */}
        {phase !== "mode" && (
          <div className="flex items-center gap-2 px-6 py-3">
            {stepLabels.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    i === stepIndex
                      ? "bg-accent/20 text-accent-soft"
                      : i < stepIndex
                      ? "text-emerald-300"
                      : "text-slate-500"
                  }`}
                >
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${
                      i < stepIndex
                        ? "bg-emerald-400/20"
                        : i === stepIndex
                        ? "bg-accent/30"
                        : "bg-surface-card"
                    }`}
                  >
                    {i < stepIndex ? <CheckIcon className="h-3 w-3" /> : i + 1}
                  </span>
                  {label}
                </div>
                {i < stepLabels.length - 1 && (
                  <span className="h-px w-6 bg-surface-border" />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {phase === "mode" && (
            <ModeStep
              onPick={(m) => {
                setMode(m);
                setPhase(m === "goal" ? "category" : "template");
              }}
            />
          )}

          {phase === "category" && (
            <CategoryStep
              selected={category}
              onSelect={(c) => {
                setCategory(c);
                setPhase("purpose");
              }}
            />
          )}

          {phase === "purpose" && category && (
            <PurposeStep category={category} onSelect={handleSelectPurpose} />
          )}

          {phase === "template" && (
            <TemplateStep selected={template} onSelect={setTemplate} />
          )}

          {phase === "details" && template && (
            <DetailsStep
              template={template}
              name={name}
              setName={setName}
              nameIsValid={nameIsValid || name.length === 0}
              parentDir={parentDir}
              onPickDir={handlePickDir}
              setParentDir={setParentDir}
              summary={summary}
              setSummary={setSummary}
              status={status}
              setStatus={setStatus}
              showTerminal={showTerminal}
              setShowTerminal={setShowTerminal}
            />
          )}

          {phase === "preflight" && template && (
            <PreflightStep
              template={template}
              prereqs={prereqs}
              loading={prereqLoading}
              error={prereqError}
              installing={installing}
              installErrors={installErrors}
              onInstall={handleInstall}
              onOpenUrl={(url) => openUrl(url)}
              onRecheck={() => loadPrereqs(template.id)}
            />
          )}

          {phase === "running" && template && (
            <RunningStep
              template={template}
              name={name}
              showTerminal={showTerminal}
              lines={buildLines}
            />
          )}

          {phase === "generate" && created && purpose && (
            <GenerateStep project={created} purpose={purpose} prompt={goalPrompt} />
          )}

          {phase === "done" && created && (
            <DoneStep
              project={created}
              onOpenInCode={() => onOpenInCode(created)}
              onClose={onClose}
            />
          )}

          {phase === "error" && (
            <ErrorStep
              message={error}
              onRetry={() => setPhase("details")}
              onClose={onClose}
            />
          )}
        </div>

        {/* Footer: mode / category / purpose (selection advances; just Back/Cancel) */}
        {(phase === "mode" || phase === "category" || phase === "purpose") && (
          <div className="flex items-center justify-start border-t border-surface-border px-6 py-4">
            <button
              onClick={() =>
                phase === "purpose"
                  ? setPhase("category")
                  : phase === "category"
                  ? setPhase("mode")
                  : onClose()
              }
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              {phase === "mode" ? "Cancel" : "Back"}
            </button>
          </div>
        )}

        {/* Footer nav: template / details */}
        {(phase === "template" || phase === "details") && (
          <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
            <button
              onClick={() =>
                phase === "details"
                  ? setPhase(mode === "goal" ? "purpose" : "template")
                  : mode === "goal"
                  ? setPhase("category")
                  : onClose()
              }
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              {phase === "details" || mode === "goal" ? "Back" : "Cancel"}
            </button>

            {phase === "template" ? (
              <button
                onClick={() => setPhase("details")}
                disabled={!template}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
                <ArrowRightIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleContinueToPreflight}
                disabled={!canBuild}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
                <ArrowRightIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {/* Preflight footer */}
        {phase === "preflight" && (
          <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
            <button
              onClick={() => setPhase("details")}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={handleBuild}
              disabled={!readyToBuild}
              title={
                readyToBuild
                  ? undefined
                  : "Install the required tools above before continuing."
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SparkIcon className="h-4 w-4" />
              Create Project
            </button>
          </div>
        )}

        {/* Generate footer */}
        {phase === "generate" && created && (
          <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
            <button
              onClick={() => onOpenInCode(created)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3.5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
            >
              <CodeIcon className="h-4 w-4" />
              Proceed to Code
            </button>
            <button
              onClick={onClose}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
            >
              Finish
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Step: Mode ------------------------------- */

function ModeStep({ onPick }: { onPick: (m: WizardMode) => void }) {
  const cards: {
    mode: WizardMode;
    title: string;
    blurb: string;
    icon: typeof LayersIcon;
    accent: string;
  }[] = [
    {
      mode: "goal",
      title: "Build by goal",
      blurb: "Pick a category like Finance or Fun and tell us what you want to make. We choose the tech and draft an AI starter.",
      icon: CompassIcon,
      accent: "from-accent/25 to-accent-soft/10",
    },
    {
      mode: "framework",
      title: "Build by framework",
      blurb: "Know the stack already? Pick a template (React, FastAPI, Rust…) and scaffold it directly.",
      icon: LayersIcon,
      accent: "from-sky-500/20 to-cyan-400/10",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <button
            key={c.mode}
            onClick={() => onPick(c.mode)}
            className="group relative overflow-hidden rounded-xl border border-surface-border bg-surface-card p-5 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow"
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${c.accent} opacity-0 transition-opacity group-hover:opacity-100`}
            />
            <div className="relative">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-raised text-accent-soft">
                <Icon className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-100">
                {c.title}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                {c.blurb}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------- Step: Category ----------------------------- */

function CategoryStep({
  selected,
  onSelect,
}: {
  selected: Category | null;
  onSelect: (c: Category) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
      {CATEGORIES.map((c) => {
        const active = selected?.id === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c)}
            className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
              active
                ? "border-accent/60 bg-surface-card shadow-glow"
                : "border-surface-border bg-surface-card hover:border-accent/30 hover:bg-surface-hover"
            }`}
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${c.accent} opacity-0 transition-opacity group-hover:opacity-100`}
            />
            <div className="relative flex items-start gap-3">
              <span className="text-2xl">{c.glyph}</span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-100">{c.name}</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                  {c.description}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {c.purposes.length} ideas
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- Step: Purpose ----------------------------- */

function PurposeStep({
  category,
  onSelect,
}: {
  category: Category;
  onSelect: (p: Purpose) => void;
}) {
  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2 pb-1 text-sm text-slate-400">
        <span className="text-lg">{category.glyph}</span>
        <span>What kind of {category.name.toLowerCase()} project?</span>
      </div>
      {category.purposes.map((p) => {
        const t = getTemplate(p.templateId);
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className="group flex w-full items-center gap-3 rounded-xl border border-surface-border bg-surface-card p-3.5 text-left transition-all hover:border-accent/40 hover:bg-surface-hover"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-100">{p.name}</span>
                {t && (
                  <span className="rounded-md border border-surface-border bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                    {t.glyph} {t.name}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">{p.description}</p>
            </div>
            <ArrowRightIcon className="h-4 w-4 shrink-0 text-slate-600 transition-colors group-hover:text-accent-soft" />
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- Step: Generate ---------------------------- */

type GenPhase =
  | "idle"
  | "generating"
  | "preview"
  | "applying"
  | "applied"
  | "error";

function GenerateStep({
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

      {/* API key (not persisted) */}
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
          Kept in memory only — not saved (secure keychain storage is the next step).
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

/* ----------------------------- Step: Template ---------------------------- */

function TemplateStep({
  selected,
  onSelect,
}: {
  selected: Template | null;
  onSelect: (t: Template) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
      {TEMPLATES.map((t) => {
        const active = selected?.id === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t)}
            className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
              active
                ? "border-accent/60 bg-surface-card shadow-glow"
                : "border-surface-border bg-surface-card hover:border-accent/30 hover:bg-surface-hover"
            }`}
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${t.accent} opacity-0 transition-opacity group-hover:opacity-100 ${
                active ? "opacity-100" : ""
              }`}
            />
            <div className="relative">
              <div className="flex items-center justify-between">
                <span className="text-2xl">{t.glyph}</span>
                {active && (
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-accent text-white">
                    <CheckIcon className="h-3 w-3" />
                  </span>
                )}
              </div>
              <h3 className="mt-3 text-sm font-semibold text-slate-100">
                {t.name}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {t.description}
              </p>
              <p className="mt-3 text-[11px] text-slate-500">
                Requires{" "}
                <span className="font-mono text-slate-400">{t.requires}</span> on your PATH
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- Step: Details ----------------------------- */

function DetailsStep(props: {
  template: Template;
  name: string;
  setName: (v: string) => void;
  nameIsValid: boolean;
  parentDir: string;
  setParentDir: (v: string) => void;
  onPickDir: () => void;
  summary: string;
  setSummary: (v: string) => void;
  status: ProjectStatus;
  setStatus: (v: ProjectStatus) => void;
  showTerminal: boolean;
  setShowTerminal: (v: boolean) => void;
}) {
  const {
    template,
    name,
    setName,
    nameIsValid,
    parentDir,
    setParentDir,
    onPickDir,
    summary,
    setSummary,
    status,
    setStatus,
    showTerminal,
    setShowTerminal,
  } = props;

  return (
    <div className="space-y-5 pt-2">
      <div className="flex items-center gap-3 rounded-xl border border-surface-border bg-surface-card p-3">
        <span className="text-xl">{template.glyph}</span>
        <div>
          <p className="text-sm font-medium text-slate-200">{template.name}</p>
          <p className="text-xs text-slate-500">{template.frameworks.join(" · ")}</p>
        </div>
      </div>

      <Field label="Project name" hint={!nameIsValid ? "Use letters, numbers, dots, dashes or underscores." : undefined} invalid={!nameIsValid}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-awesome-app"
          autoFocus
          spellCheck={false}
          className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60"
        />
      </Field>

      <Field label="Location">
        <div className="flex gap-2">
          <input
            value={parentDir}
            onChange={(e) => setParentDir(e.target.value)}
            placeholder={isTauri() ? "Choose a folder…" : "~/Developer"}
            spellCheck={false}
            className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60"
          />
          <button
            onClick={onPickDir}
            disabled={!isTauri()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:opacity-40"
          >
            <FolderIcon className="h-4 w-4" />
            Browse
          </button>
        </div>
        {parentDir && name && (
          <p className="mt-1.5 truncate font-mono text-[11px] text-slate-500">
            → {parentDir.replace(/\/$/, "")}/{name.trim()}
          </p>
        )}
      </Field>

      <Field label="Plain English summary" hint="What is this project, in words anyone could understand?">
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          placeholder="The friendly app that helps people track their daily habits."
          className="w-full resize-none rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60"
        />
      </Field>

      <Field label="Status">
        <div className="flex flex-wrap gap-2">
          {PROJECT_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                status === s
                  ? "border-accent/60 bg-accent/15 text-accent-soft"
                  : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </Field>

      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-surface-border bg-surface-card p-3">
        <input
          type="checkbox"
          checked={showTerminal}
          onChange={(e) => setShowTerminal(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        <span className="flex items-center gap-1.5 text-sm text-slate-300">
          <TerminalIcon className="h-4 w-4 text-slate-500" />
          Show live terminal output while building
        </span>
      </label>
    </div>
  );
}

/* ---------------------------- Step: Preflight ---------------------------- */

function PreflightStep(props: {
  template: Template;
  prereqs: Prerequisite[];
  loading: boolean;
  error: string;
  installing: Record<string, boolean>;
  installErrors: Record<string, string>;
  onInstall: (key: string) => void;
  onOpenUrl: (url: string) => void;
  onRecheck: () => void;
}) {
  const {
    template,
    prereqs,
    loading,
    error,
    installing,
    installErrors,
    onInstall,
    onOpenUrl,
    onRecheck,
  } = props;

  if (loading && prereqs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-400">
        <RefreshIcon className="h-6 w-6 animate-spin text-accent-soft" />
        <p className="mt-3 text-sm">Checking what {template.name} needs…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center py-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30">
          <AlertIcon className="h-6 w-6" />
        </span>
        <p className="mt-3 max-w-sm text-sm text-slate-400">{error}</p>
        <button
          onClick={onRecheck}
          className="mt-4 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-slate-200 hover:bg-surface-hover"
        >
          Try again
        </button>
      </div>
    );
  }

  const missingRequired = prereqs.filter((p) => p.required && !p.installed);

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          {prereqs.length === 0
            ? `${template.name} has no prerequisites — you're good to go.`
            : missingRequired.length === 0
            ? "Everything required is installed."
            : "A few things are needed before we can build."}
        </p>
        {prereqs.length > 0 && (
          <button
            onClick={onRecheck}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300 disabled:opacity-50"
          >
            <RefreshIcon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Recheck
          </button>
        )}
      </div>

      {prereqs.map((p) => {
        const isInstalling = !!installing[p.key];
        const rowErr = installErrors[p.key];
        return (
          <div
            key={p.key}
            className="rounded-xl border border-surface-border bg-surface-card p-3"
          >
            <div className="flex items-center gap-3">
              {/* Status glyph */}
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                  p.installed
                    ? "bg-emerald-400/15 text-emerald-300"
                    : p.required
                    ? "bg-rose-500/15 text-rose-300"
                    : "bg-amber-400/15 text-amber-300"
                }`}
              >
                {p.installed ? (
                  <CheckCircleIcon className="h-4 w-4" />
                ) : (
                  <AlertIcon className="h-4 w-4" />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{p.name}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      p.required
                        ? "bg-surface-raised text-slate-400"
                        : "bg-surface-raised text-slate-500"
                    }`}
                  >
                    {p.required ? "Required" : "Recommended"}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {p.installed
                    ? p.version ?? "Installed"
                    : p.installHint}
                </p>
              </div>

              {/* Action */}
              {p.installed ? (
                <span className="shrink-0 text-xs font-medium text-emerald-300">Ready</span>
              ) : isInstalling ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-slate-400">
                  <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
                  Installing…
                </span>
              ) : p.autoInstallable ? (
                <button
                  onClick={() => onInstall(p.key)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow"
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                  Install
                </button>
              ) : (
                <button
                  onClick={() => onOpenUrl(p.url)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-surface-border bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
                >
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                  Get it
                </button>
              )}
            </div>

            {rowErr && (
              <pre
                data-selectable="true"
                className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg border border-surface-border bg-surface-base p-2 font-mono text-[11px] leading-relaxed text-rose-200/90"
              >
                {rowErr}
              </pre>
            )}
          </div>
        );
      })}

      {missingRequired.length === 0 && prereqs.length > 0 && (
        <p className="pt-1 text-xs text-emerald-300/80">
          Click <span className="font-medium">Create Project</span> to scaffold{" "}
          {template.name}.
        </p>
      )}
    </div>
  );
}

/* ----------------------------- Step: Running ----------------------------- */

function RunningStep({
  template,
  name,
  showTerminal,
  lines,
}: {
  template: Template;
  name: string;
  showTerminal: boolean;
  lines: { line: string; stream: string }[];
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest output in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="relative grid h-16 w-16 place-items-center">
        <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent/30" />
        <span className="absolute inset-2 animate-pulse-ring rounded-full bg-accent/20 [animation-delay:0.4s]" />
        <span className="relative grid h-11 w-11 animate-spin place-items-center rounded-full border-2 border-accent/30 border-t-accent text-xl [animation-duration:1.2s]">
          <span className="animate-none">{template.glyph}</span>
        </span>
      </div>
      <h3 className="mt-5 text-base font-semibold text-slate-100">
        Bootstrapping <span className="font-mono text-accent-soft">{name}</span>
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-slate-400">
        Running the {template.name} setup. This can take a moment while
        dependencies are fetched…
      </p>

      {showTerminal ? (
        <div className="mt-5 w-full text-left">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <TerminalIcon className="h-3.5 w-3.5" />
            Terminal
          </div>
          <div className="h-48 overflow-y-auto rounded-xl border border-surface-border bg-surface-base p-3 font-mono text-[11px] leading-relaxed">
            {lines.length === 0 ? (
              <span className="text-slate-600">Waiting for output…</span>
            ) : (
              lines.map((l, i) => (
                <div
                  key={i}
                  data-selectable="true"
                  className={`whitespace-pre-wrap break-words ${
                    l.stream === "stderr" ? "text-amber-300/90" : "text-slate-300"
                  }`}
                >
                  {l.line || " "}
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>
        </div>
      ) : (
        <div className="relative mt-6 h-1.5 w-64 overflow-hidden rounded-full bg-surface-card">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-shimmer rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Step: Done ------------------------------- */

function DoneStep({
  project,
  onOpenInCode,
  onClose,
}: {
  project: Project;
  onOpenInCode: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30 animate-scale-in">
        <CheckIcon className="h-8 w-8" />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-slate-100">
        {project.name} is ready
      </h3>
      <p className="mt-1.5 max-w-sm text-sm text-slate-400">
        Your project was created at
      </p>
      <code
        data-selectable="true"
        className="mt-1 max-w-full truncate rounded-md bg-surface-card px-2 py-1 font-mono text-xs text-slate-300"
      >
        {project.path}
      </code>

      <div className="mt-6 flex items-center gap-2">
        <button
          onClick={onOpenInCode}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
        >
          <CodeIcon className="h-4 w-4" />
          Proceed to Code
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ Step: Error ------------------------------ */

function ErrorStep({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30">
        <AlertIcon className="h-7 w-7" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-slate-100">
        Couldn't create the project
      </h3>
      <pre
        data-selectable="true"
        className="mt-3 max-h-40 w-full overflow-auto whitespace-pre-wrap rounded-lg border border-surface-border bg-surface-base p-3 text-left font-mono text-xs leading-relaxed text-rose-200/90"
      >
        {message}
      </pre>
      <p className="mt-2 text-[11px] text-slate-500">
        Also saved to <span className="font-mono">kinetek-errors.log</span> in the project root.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={onRetry}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
        >
          Back to details
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
        >
          Close
        </button>
      </div>
    </div>
  );
}
