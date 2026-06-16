import { AlertIcon } from "../icons";

/** Terminal failure state for scaffolding. */
export default function ErrorStep({
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
