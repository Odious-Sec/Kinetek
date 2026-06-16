import { useCallback, useEffect, useState } from "react";
import type { PreviewStatus, Project } from "../types";
import {
  installDeps,
  installPreviewRequirement,
  openPreviewWindow,
  openUrl,
  previewStatus,
  splitPreviewError,
  startPreview,
} from "../lib/tauri";
import {
  AlertIcon,
  CheckCircleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  PlayIcon,
  RefreshIcon,
  XIcon,
} from "./icons";

interface Props {
  project: Project;
  onClose: () => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

type PreviewError = { friendly: string; dev: string };

/**
 * One place for all of "can I preview this, and if not what's missing": shows
 * the detected project kind, lists the requirements (with preview-only installs),
 * runs it, and on failure explains why in plain English — with the raw developer
 * output behind a toggle.
 */
export default function PreviewDialog({ project, onClose, notify }: Props) {
  const [status, setStatus] = useState<PreviewStatus | "loading">("loading");
  const [busyKey, setBusyKey] = useState<string | null>(null); // requirement/deps being installed
  const [running, setRunning] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState<PreviewError | null>(null);
  const [showDev, setShowDev] = useState(false);

  const load = useCallback(() => {
    setStatus("loading");
    previewStatus(project.path)
      .then(setStatus)
      .catch((e) => {
        setStatus("loading");
        notify("err", typeof e === "string" ? e : String(e));
      });
  }, [project.path, notify]);

  useEffect(() => {
    setError(null);
    setLaunched(false);
    load();
  }, [load]);

  async function installReq(key: string) {
    setBusyKey(key);
    setError(null);
    try {
      await installPreviewRequirement(key);
      notify("ok", `Installed ${key}.`);
      load(); // re-check requirements
    } catch (e) {
      setError(splitPreviewError(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function installNpm() {
    setBusyKey("deps");
    setError(null);
    try {
      await installDeps(project.path);
      notify("ok", "Installed dependencies.");
      load();
    } catch (e) {
      setError(splitPreviewError(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function run() {
    setRunning(true);
    setError(null);
    setLaunched(false);
    try {
      const info = await startPreview(project.path);
      if (info.url) {
        // Web / static — open it in a Kinetek window.
        await openPreviewWindow(project, info);
        notify("ok", `Previewing ${project.name}…`);
        onClose();
      } else {
        // Native (.NET) — built cleanly and launched in its own window.
        setLaunched(true);
        notify("ok", `${project.name} built and launched.`);
      }
    } catch (e) {
      setError(splitPreviewError(e));
    } finally {
      setRunning(false);
    }
  }

  const s = status === "loading" ? null : status;
  const runLabel =
    s?.runner === "dotnet" ? "Build & run" : "Open preview";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={running ? undefined : onClose} />

      <div className="relative z-10 flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface-raised shadow-glow animate-scale-in">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-surface-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/20 text-accent-soft">
              <EyeIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-100">Preview {project.name}</h2>
              <p className="text-xs text-slate-500">
                {status === "loading" ? "Checking what this project needs…" : s?.how || "Run this project locally."}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={running}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200 disabled:opacity-30"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {status === "loading" ? (
            <div className="flex items-center justify-center py-10 text-sm text-slate-500">
              <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Checking…
            </div>
          ) : !s!.previewable ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-amber-400/15 text-amber-300">
                <AlertIcon className="h-6 w-6" />
              </span>
              <p className="max-w-sm text-sm text-slate-400">{s!.message}</p>
            </div>
          ) : launched ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30 animate-scale-in">
                <CheckCircleIcon className="h-7 w-7" />
              </span>
              <div>
                <h3 className="text-base font-semibold text-slate-100">Built &amp; launched</h3>
                <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
                  {project.name} compiled cleanly and is opening in its own window.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Requirements */}
              {(s!.requirements.length > 0 || s!.needsInstall) && (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                    Requirements
                  </p>

                  {s!.requirements.map((r) => (
                    <RequirementRow
                      key={r.key}
                      name={r.name}
                      detail={r.detail}
                      satisfied={r.satisfied}
                      busy={busyKey === r.key}
                      action={
                        r.satisfied ? null : r.installable ? (
                          <InstallButton busy={busyKey === r.key} label={r.installLabel} onClick={() => installReq(r.key)} />
                        ) : r.url ? (
                          <GetItButton onClick={() => openUrl(r.url)} />
                        ) : null
                      }
                    />
                  ))}

                  {s!.needsInstall && (
                    <RequirementRow
                      name="Project dependencies"
                      detail="node_modules isn't installed yet."
                      satisfied={false}
                      busy={busyKey === "deps"}
                      action={<InstallButton busy={busyKey === "deps"} label="npm install" onClick={installNpm} />}
                    />
                  )}
                </div>
              )}

              {/* Friendly + dev error */}
              {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
                  <div className="flex items-start gap-2">
                    <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                    <p className="text-sm text-rose-100/90">{error.friendly}</p>
                  </div>
                  {error.dev && (
                    <div className="mt-2">
                      <button
                        onClick={() => setShowDev((v) => !v)}
                        className="text-[11px] font-medium text-slate-400 hover:text-slate-200"
                      >
                        {showDev ? "Hide" : "Show"} developer details
                      </button>
                      {showDev && (
                        <pre
                          data-selectable="true"
                          className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-surface-border bg-surface-base p-2.5 font-mono text-[11px] leading-relaxed text-rose-200/80"
                        >
                          {error.dev}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}

              {s!.ready && !error && (
                <p className="text-xs text-emerald-300/80">
                  Everything's ready — click {runLabel} to preview.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {status !== "loading" && s!.previewable && !launched && (
          <div className="flex items-center justify-between border-t border-surface-border px-5 py-4">
            <button
              onClick={load}
              disabled={running || !!busyKey}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-40"
            >
              <RefreshIcon className={`h-3.5 w-3.5 ${busyKey ? "animate-spin" : ""}`} />
              Re-check
            </button>
            <button
              onClick={run}
              disabled={!s!.ready || running || !!busyKey}
              title={s!.ready ? undefined : "Install the requirements above first."}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? (
                <>
                  <RefreshIcon className="h-4 w-4 animate-spin" />
                  {s!.runner === "dotnet" ? "Building…" : "Starting…"}
                </>
              ) : (
                <>
                  <PlayIcon className="h-4 w-4" />
                  {runLabel}
                </>
              )}
            </button>
          </div>
        )}

        {launched && (
          <div className="flex justify-end border-t border-surface-border px-5 py-4">
            <button
              onClick={onClose}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RequirementRow({
  name,
  detail,
  satisfied,
  busy,
  action,
}: {
  name: string;
  detail: string;
  satisfied: boolean;
  busy: boolean;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-surface-border bg-surface-card p-3">
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
          satisfied ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"
        }`}
      >
        {satisfied ? <CheckCircleIcon className="h-4 w-4" /> : <AlertIcon className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-100">{name}</p>
        <p className="truncate text-xs text-slate-500" title={detail}>
          {busy ? "Installing… this can take a while." : detail}
        </p>
      </div>
      {satisfied ? (
        <span className="shrink-0 text-xs font-medium text-emerald-300">Ready</span>
      ) : (
        <div className="shrink-0">{action}</div>
      )}
    </div>
  );
}

function InstallButton({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow disabled:opacity-50"
    >
      {busy ? <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> : <DownloadIcon className="h-3.5 w-3.5" />}
      {busy ? "Installing…" : label}
    </button>
  );
}

function GetItButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
    >
      <ExternalLinkIcon className="h-3.5 w-3.5" />
      Get it
    </button>
  );
}
