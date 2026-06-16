import type { ProjectStatus, Template } from "../../types";
import { PROJECT_STATUSES } from "../../types";
import { isTauri } from "../../lib/tauri";
import Field from "../Field";
import { FolderIcon, TerminalIcon } from "../icons";

/** Shared step: name, location, summary, status, and the terminal toggle. */
export default function DetailsStep(props: {
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
