import type { Prerequisite, Template } from "../../types";
import {
  AlertIcon,
  CheckCircleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  RefreshIcon,
} from "../icons";

/** Step: check (and offer to install) the tools the chosen template needs. */
export default function PreflightStep(props: {
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
