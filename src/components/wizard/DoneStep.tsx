import type { Project } from "../../types";
import { CheckIcon, CodeIcon } from "../icons";

/** Terminal success state for the framework-first path. */
export default function DoneStep({
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
