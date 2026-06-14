import { useState } from "react";
import type { Folder } from "../types";
import {
  CheckIcon,
  CompassIcon,
  FolderIcon,
  FolderPlusIcon,
  LayersIcon,
  PencilIcon,
  TrashIcon,
  XIcon,
} from "./icons";

export type FolderSelection = "all" | "unfiled" | string;
export type ViewMode = "dashboard" | "explorer";

interface Props {
  view: ViewMode;
  onView: (v: ViewMode) => void;
  folders: Folder[];
  counts: { all: number; unfiled: number; byFolder: Record<string, number> };
  selected: FolderSelection;
  onSelect: (sel: FolderSelection) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (folder: Folder) => void;
}

export default function Sidebar({
  view,
  onView,
  folders,
  counts,
  selected,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  function commitNew() {
    const name = newName.trim();
    if (name) onCreate(name);
    setNewName("");
    setAdding(false);
  }

  function commitRename(id: string) {
    const name = editName.trim();
    if (name) onRename(id, name);
    setEditingId(null);
    setEditName("");
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-surface-border bg-surface-base/60">
      {/* View switch */}
      <div className="flex items-center gap-1 border-b border-surface-border p-2">
        <ViewTab
          active={view === "dashboard"}
          icon={<LayersIcon className="h-4 w-4" />}
          label="Dashboard"
          onClick={() => onView("dashboard")}
        />
        <ViewTab
          active={view === "explorer"}
          icon={<CompassIcon className="h-4 w-4" />}
          label="Explorer"
          onClick={() => onView("explorer")}
        />
      </div>

      {view === "explorer" ? (
        <div className="flex-1 px-3 py-4 text-xs leading-relaxed text-slate-500">
          Browse your files like a finder. Read-only — nothing is moved or
          changed.
        </div>
      ) : (
        <>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        <Row
          icon={<LayersIcon className="h-4 w-4" />}
          label="All Projects"
          count={counts.all}
          active={selected === "all"}
          onClick={() => onSelect("all")}
        />
        <Row
          icon={<FolderIcon className="h-4 w-4" />}
          label="Unfiled"
          count={counts.unfiled}
          active={selected === "unfiled"}
          onClick={() => onSelect("unfiled")}
        />

        {folders.length > 0 && (
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            Folders
          </div>
        )}

        {folders.map((f) =>
          editingId === f.id ? (
            <input
              key={f.id}
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => commitRename(f.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(f.id);
                if (e.key === "Escape") {
                  setEditingId(null);
                  setEditName("");
                }
              }}
              className="w-full rounded-lg border border-accent/60 bg-surface-base px-2.5 py-1.5 text-sm text-slate-100 outline-none"
            />
          ) : (
            <div key={f.id} className="group/row relative">
              <Row
                icon={<FolderIcon className="h-4 w-4" />}
                label={f.name}
                count={counts.byFolder[f.id] ?? 0}
                active={selected === f.id}
                onClick={() => onSelect(f.id)}
              />
              <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover/row:flex">
                <button
                  title="Rename folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(f.id);
                    setEditName(f.name);
                  }}
                  className="rounded p-1 text-slate-500 hover:bg-surface-hover hover:text-slate-200"
                >
                  <PencilIcon className="h-3 w-3" />
                </button>
                <button
                  title="Delete folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(f);
                  }}
                  className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                >
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
            </div>
          )
        )}

        {adding && (
          <div className="flex items-center gap-1 pt-1">
            <input
              autoFocus
              value={newName}
              placeholder="Folder name"
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitNew}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNew();
                if (e.key === "Escape") {
                  setNewName("");
                  setAdding(false);
                }
              }}
              className="w-full rounded-lg border border-accent/60 bg-surface-base px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitNew}
              className="rounded-lg bg-accent p-1.5 text-white hover:bg-accent-glow"
            >
              <CheckIcon className="h-3.5 w-3.5" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setNewName("");
                setAdding(false);
              }}
              className="rounded-lg border border-surface-border p-1.5 text-slate-400 hover:bg-surface-hover"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </nav>

      <div className="shrink-0 border-t border-surface-border p-2">
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
        >
          <FolderPlusIcon className="h-4 w-4" />
          New folder
        </button>
      </div>
        </>
      )}
    </aside>
  );
}

function ViewTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-accent/15 text-accent-soft"
          : "text-slate-400 hover:bg-surface-hover hover:text-slate-200"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Row({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-accent/15 text-accent-soft"
          : "text-slate-300 hover:bg-surface-hover"
      }`}
    >
      <span className={active ? "text-accent-soft" : "text-slate-500"}>{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      <span className="text-xs text-slate-500">{count}</span>
    </button>
  );
}
