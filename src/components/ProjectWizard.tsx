import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Category,
  Platform,
  Prerequisite,
  Project,
  ProjectStatus,
  Purpose,
  Template,
  WizardMode,
} from "../types";
import { getTemplate } from "../lib/templates";
import { DATABASES, frameworksFor, type AppCategory } from "../lib/catalog";
import { composePrompt } from "../lib/categories";
import {
  checkPrerequisites,
  createProject,
  installTool,
  isTauri,
  logError,
  openUrl,
  pickDirectory,
} from "../lib/tauri";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CodeIcon,
  SparkIcon,
  XIcon,
} from "./icons";
import ModeStep from "./wizard/ModeStep";
import CategoryStep from "./wizard/CategoryStep";
import PurposeStep from "./wizard/PurposeStep";
import AppTypeStep from "./wizard/AppTypeStep";
import PlatformStep from "./wizard/PlatformStep";
import TemplateStep from "./wizard/TemplateStep";
import StackStep from "./wizard/StackStep";
import DetailsStep from "./wizard/DetailsStep";
import PreflightStep from "./wizard/PreflightStep";
import RunningStep from "./wizard/RunningStep";
import GenerateStep from "./wizard/GenerateStep";
import DoneStep from "./wizard/DoneStep";
import ErrorStep from "./wizard/ErrorStep";

type Phase =
  | "mode"
  | "category"
  | "purpose"
  | "appType"
  | "platform"
  | "template"
  | "stack"
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

/**
 * Orchestrates the New Project flow: holds the wizard state machine and the
 * shared build/preflight logic, and delegates each phase's UI to a focused
 * step component in `./wizard/`.
 */
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

  // Framework-first funnel state (App type → platform → framework).
  const [appCat, setAppCat] = useState<AppCategory | null>(null);
  const [appPlatform, setAppPlatform] = useState<Platform | null>(null);

  // Optional stack add-ons (shared by both paths).
  const [apiTemplate, setApiTemplate] = useState<Template | null>(null);
  const [dbEngine, setDbEngine] = useState<string | null>(null);
  const [prereqIds, setPrereqIds] = useState<string[]>([]);

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
      ? ["Goal", "Add-ons", "Details", "Build"]
      : ["App", "Add-ons", "Details", "Build"];

  const stepIndex: number = (() => {
    switch (phase) {
      case "stack":
        return 1;
      case "details":
      case "error":
        return 2;
      case "preflight":
      case "running":
      case "generate":
      case "done":
        return 3;
      default: // mode / category / purpose / appType / platform / template
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

  // Check the union of prerequisites across the chosen parts (app + API).
  const loadPrereqs = useCallback(async (ids: string[]) => {
    setPrereqLoading(true);
    setPrereqError("");
    try {
      const lists = await Promise.all(ids.map((id) => checkPrerequisites(id)));
      const byKey = new Map<string, Prerequisite>();
      for (const list of lists) {
        for (const p of list) {
          const existing = byKey.get(p.key);
          if (!existing) byKey.set(p.key, p);
          else if (p.required && !existing.required) byKey.set(p.key, { ...existing, required: true });
        }
      }
      setPrereqs(Array.from(byKey.values()));
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
    setPhase("stack");
  }

  async function handleContinueToPreflight() {
    if (!template || !canBuild) return;
    const ids = [template.id, apiTemplate?.id].filter(Boolean) as string[];
    setPrereqIds(ids);
    // In a plain browser there's no backend to check — go straight to build,
    // which surfaces a clear "desktop only" error.
    if (!isTauri()) {
      handleBuild();
      return;
    }
    setPhase("preflight");
    loadPrereqs(ids);
  }

  async function handleInstall(key: string) {
    setInstalling((m) => ({ ...m, [key]: true }));
    setInstallErrors((m) => ({ ...m, [key]: "" }));
    try {
      await installTool(key);
      await loadPrereqs(prereqIds);
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
      const dbName = dbEngine ? DATABASES.find((d) => d.id === dbEngine)?.name : undefined;
      const frameworks = Array.from(
        new Set([
          ...template.frameworks,
          ...(apiTemplate?.frameworks ?? []),
          ...(dbName ? [dbName] : []),
        ])
      );
      const project = await createProject({
        parentDir,
        projectName: name.trim(),
        appTemplateId: template.id,
        apiTemplateId: apiTemplate?.id ?? null,
        databaseEngine: dbEngine,
        summary:
          summary.trim() ||
          `A new ${template.name} project, ready to be developed.`,
        status,
        frameworks,
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
                setPhase(m === "goal" ? "category" : "appType");
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

          {phase === "appType" && (
            <AppTypeStep
              selected={appCat?.kind ?? null}
              onSelect={(c) => {
                setAppCat(c);
                setAppPlatform(null);
                setTemplate(null);
                setPhase(c.platforms && c.platforms.length > 0 ? "platform" : "template");
              }}
            />
          )}

          {phase === "platform" && appCat && (
            <PlatformStep
              category={appCat}
              selected={appPlatform}
              onSelect={(p) => {
                setAppPlatform(p);
                setTemplate(null);
                setPhase("template");
              }}
            />
          )}

          {phase === "template" && appCat && (
            <TemplateStep
              templates={frameworksFor(appCat.kind, appPlatform ?? undefined)}
              selected={template}
              onSelect={setTemplate}
            />
          )}

          {phase === "stack" && (
            <StackStep
              apiTemplate={apiTemplate}
              setApiTemplate={setApiTemplate}
              dbEngine={dbEngine}
              setDbEngine={setDbEngine}
            />
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
              onRecheck={() => loadPrereqs(prereqIds)}
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

        {/* Footer: selection-advances phases (just Back/Cancel) */}
        {(phase === "mode" ||
          phase === "category" ||
          phase === "purpose" ||
          phase === "appType" ||
          phase === "platform") && (
          <div className="flex items-center justify-start border-t border-surface-border px-6 py-4">
            <button
              onClick={() => {
                if (phase === "purpose") setPhase("category");
                else if (phase === "platform") setPhase("appType");
                else if (phase === "category" || phase === "appType") setPhase("mode");
                else onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              {phase === "mode" ? "Cancel" : "Back"}
            </button>
          </div>
        )}

        {/* Footer nav: template / stack / details (Back + Continue) */}
        {(phase === "template" || phase === "stack" || phase === "details") && (
          <div className="flex items-center justify-between border-t border-surface-border px-6 py-4">
            <button
              onClick={() => {
                if (phase === "details") setPhase("stack");
                else if (phase === "stack") setPhase(mode === "goal" ? "purpose" : "template");
                else if (phase === "template")
                  setPhase(appPlatform ? "platform" : "appType");
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back
            </button>

            {phase === "template" ? (
              <button
                onClick={() => setPhase("stack")}
                disabled={!template}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
                <ArrowRightIcon className="h-4 w-4" />
              </button>
            ) : phase === "stack" ? (
              <button
                onClick={() => setPhase("details")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
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
