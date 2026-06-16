import { useCallback, useEffect, useState } from "react";
import type { GitRefs, Project, StashEntry } from "../types";
import {
  gitCheckout,
  gitCreateBranch,
  gitDeleteBranch,
  gitRefs,
  gitStashApply,
  gitStashDrop,
  gitStashes,
  gitStashSave,
} from "../lib/tauri";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
  GithubIcon,
  PlusIcon,
  TagIcon,
  TrashIcon,
  XIcon,
} from "./icons";

interface Props {
  project: Project;
  /** Bumped by the parent to force a reload (e.g. after a graph action). */
  refreshKey: number;
  /** Call after any mutation so the graph + sidebar both refresh. */
  onChanged: () => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

function asMsg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

/**
 * Our own (not Fork's) refs panel: branches, remotes, tags and stashes in the
 * Kinetek visual language. Create/switch/delete branches, and stash changes you
 * don't want to push yet.
 */
export default function RefsSidebar({ project, refreshKey, onChanged, notify }: Props) {
  const [refs, setRefs] = useState<GitRefs | null>(null);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [adding, setAdding] = useState<"branch" | "stash" | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    gitRefs(project.path)
      .then(setRefs)
      .catch(() => setRefs(null));
    gitStashes(project.path)
      .then(setStashes)
      .catch(() => setStashes([]));
  }, [project.path]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const after = (msg: string) => {
    notify("ok", msg);
    setAdding(null);
    setDraft("");
    onChanged();
  };

  async function createBranch() {
    const name = draft.trim();
    if (!name) return;
    setBusy(true);
    try {
      await gitCreateBranch(project.path, name, undefined, true);
      after(`Created and switched to ${name}.`);
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveStash() {
    setBusy(true);
    try {
      await gitStashSave(project.path, draft.trim() || undefined);
      after("Stashed your changes.");
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function checkout(reference: string, label = reference) {
    setBusy(true);
    try {
      await gitCheckout(project.path, reference);
      notify("ok", `Switched to ${label}.`);
      onChanged();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeBranch(name: string) {
    setBusy(true);
    try {
      await gitDeleteBranch(project.path, name, false);
      notify("ok", `Deleted ${name}.`);
      onChanged();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyStash(index: number, pop: boolean) {
    setBusy(true);
    try {
      await gitStashApply(project.path, index, pop);
      notify("ok", pop ? "Popped the stash." : "Applied the stash.");
      onChanged();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function dropStash(index: number) {
    setBusy(true);
    try {
      await gitStashDrop(project.path, index);
      notify("ok", "Dropped the stash.");
      onChanged();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (!refs) {
    return (
      <div className="p-3 text-xs text-slate-600">Not a git repository.</div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-surface-border p-2">
        <button
          onClick={() => {
            setAdding(adding === "branch" ? null : "branch");
            setDraft("");
          }}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-glow"
        >
          <PlusIcon className="h-3.5 w-3.5" /> Branch
        </button>
        <button
          onClick={() => {
            setAdding(adding === "stash" ? null : "stash");
            setDraft("");
          }}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover"
        >
          <ArchiveIcon className="h-3.5 w-3.5" /> Stash
        </button>
      </div>

      {adding && (
        <div className="flex shrink-0 items-center gap-1 border-b border-surface-border p-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") adding === "branch" ? createBranch() : saveStash();
              if (e.key === "Escape") {
                setAdding(null);
                setDraft("");
              }
            }}
            placeholder={adding === "branch" ? "new-branch-name" : "Stash message (optional)"}
            spellCheck={false}
            className="w-full rounded-lg border border-accent/60 bg-surface-base px-2.5 py-1.5 font-mono text-xs text-slate-100 outline-none placeholder:text-slate-600"
          />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (adding === "branch" ? createBranch() : saveStash())}
            disabled={busy || (adding === "branch" && !draft.trim())}
            className="shrink-0 rounded-lg bg-accent p-1.5 text-white hover:bg-accent-glow disabled:opacity-40"
          >
            <CheckIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setAdding(null);
              setDraft("");
            }}
            className="shrink-0 rounded-lg border border-surface-border p-1.5 text-slate-400 hover:bg-surface-hover"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* Branches */}
        <Section title="Branches" icon={<GitBranchIcon className="h-3.5 w-3.5" />} count={refs.branches.length} defaultOpen>
          {refs.branches.length === 0 && <Empty>No local branches.</Empty>}
          {refs.branches.map((b) => {
            const current = !refs.detached && b === refs.current;
            return (
              <RefRow
                key={b}
                label={b}
                active={current}
                marker={current ? "current" : undefined}
                onClick={current || busy ? undefined : () => checkout(b)}
                onDelete={current ? undefined : () => removeBranch(b)}
              />
            );
          })}
        </Section>

        {/* Remotes */}
        <Section title="Remotes" icon={<GithubIcon className="h-3.5 w-3.5" />} count={refs.remotes.length}>
          {refs.remotes.length === 0 && <Empty>No remote branches.</Empty>}
          {refs.remotes.map((r) => (
            <RefRow
              key={r}
              label={r}
              onClick={busy ? undefined : () => checkout(r.split("/").slice(1).join("/") || r, r)}
            />
          ))}
        </Section>

        {/* Tags */}
        <Section title="Tags" icon={<TagIcon className="h-3.5 w-3.5" />} count={refs.tags.length}>
          {refs.tags.length === 0 && <Empty>No tags.</Empty>}
          {refs.tags.map((t) => (
            <RefRow key={t} label={t} onClick={busy ? undefined : () => checkout(t)} />
          ))}
        </Section>

        {/* Stashes */}
        <Section title="Stashes" icon={<ArchiveIcon className="h-3.5 w-3.5" />} count={stashes.length}>
          {stashes.length === 0 && <Empty>Nothing stashed.</Empty>}
          {stashes.map((s) => (
            <div
              key={s.index}
              className="group/stash flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-surface-hover"
            >
              <ArchiveIcon className="h-3 w-3 shrink-0 text-slate-500" />
              <span className="min-w-0 flex-1 truncate text-slate-300" title={s.message}>
                {s.message || `stash@{${s.index}}`}
              </span>
              <div className="hidden shrink-0 items-center gap-1 group-hover/stash:flex">
                <button onClick={() => applyStash(s.index, false)} disabled={busy} className="text-[10px] text-slate-400 hover:text-accent-soft">
                  Apply
                </button>
                <button onClick={() => applyStash(s.index, true)} disabled={busy} className="text-[10px] text-slate-400 hover:text-emerald-300">
                  Pop
                </button>
                <button onClick={() => dropStash(s.index)} disabled={busy} className="text-slate-500 hover:text-rose-300">
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 transition-colors hover:bg-surface-hover hover:text-slate-300"
      >
        {open ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        <span className="text-slate-500">{icon}</span>
        <span className="flex-1 text-left">{title}</span>
        <span className="text-slate-600">{count}</span>
      </button>
      {open && <div className="mt-0.5 space-y-0.5 pl-1">{children}</div>}
    </div>
  );
}

function RefRow({
  label,
  active,
  marker,
  onClick,
  onDelete,
}: {
  label: string;
  active?: boolean;
  marker?: string;
  onClick?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="group/ref relative">
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
          active ? "bg-accent/15 text-accent-soft" : "text-slate-300"
        } ${onClick ? "hover:bg-surface-hover" : "cursor-default"}`}
      >
        {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-soft" />}
        <span className="min-w-0 flex-1 truncate font-mono" title={label}>
          {label}
        </span>
        {marker && <span className="shrink-0 text-[10px] text-slate-500">{marker}</span>}
      </button>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete branch"
          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 group-hover/ref:block"
        >
          <TrashIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1 text-[11px] text-slate-600">{children}</p>;
}
