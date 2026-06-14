import { AlertIcon, XIcon } from "./icons";

interface Props {
  title: string;
  message: string;
  /** Extra detail shown in a monospace box (e.g. a path). */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  destructive?: boolean;
  busy?: boolean;
  /** An error to display (e.g. a failed first attempt). */
  error?: string;
  /** Optional extra action, shown alongside confirm (e.g. a fallback). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  busy,
  error,
  secondaryLabel,
  onSecondary,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={busy ? undefined : onCancel}
      />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-surface-border bg-surface-raised shadow-glow animate-scale-in">
        <div className="flex items-start gap-3 p-5">
          <span
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
              destructive
                ? "bg-rose-500/15 text-rose-300"
                : "bg-accent/15 text-accent-soft"
            }`}
          >
            <AlertIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
            <p className="mt-1 text-sm text-slate-400">{message}</p>
            {detail && (
              <code
                data-selectable="true"
                className="mt-2 block max-w-full truncate rounded-md bg-surface-card px-2 py-1 font-mono text-xs text-slate-300"
              >
                {detail}
              </code>
            )}
            {error && (
              <pre
                data-selectable="true"
                className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[11px] leading-relaxed text-rose-200/90"
              >
                {error}
              </pre>
            )}
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg p-1 text-slate-500 transition-colors hover:bg-surface-hover hover:text-slate-300 disabled:opacity-30"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-5 py-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-surface-border bg-surface-card px-3.5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              onClick={onSecondary}
              disabled={busy}
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
            >
              {secondaryLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              destructive
                ? "bg-rose-600 hover:bg-rose-500"
                : "bg-accent hover:bg-accent-glow"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
