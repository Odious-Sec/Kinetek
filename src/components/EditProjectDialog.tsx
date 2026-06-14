import { useState } from "react";
import type { Project, ProjectStatus } from "../types";
import { PROJECT_STATUSES } from "../types";
import Field from "./Field";
import { XIcon } from "./icons";

interface Props {
  project: Project;
  onSave: (updated: Project) => void;
  onCancel: () => void;
}

/** Inline editor for a card's human metadata: name, summary, status, tags. */
export default function EditProjectDialog({ project, onSave, onCancel }: Props) {
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [tags, setTags] = useState(project.frameworks.join(", "));

  function handleSave() {
    onSave({
      ...project,
      name: name.trim() || project.name,
      summary: summary.trim(),
      status,
      frameworks: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-surface-border bg-surface-raised shadow-glow animate-scale-in">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-100">Edit project</h3>
          <button
            onClick={onCancel}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-accent/60"
            />
          </Field>

          <Field label="Plain English summary">
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              placeholder="What is this project, in words anyone could understand?"
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

          <Field label="Tags" hint="Comma-separated (e.g. React, Vite, TypeScript).">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-accent/60"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-surface-border bg-surface-card px-3.5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow"
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
