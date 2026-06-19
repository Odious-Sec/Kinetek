import { useEffect, useState } from "react";
import type { DirEntry } from "../types";
import { readDir } from "../lib/tauri";
import { revealLabel } from "../lib/platform";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
} from "./icons";

/**
 * A reusable, read-only, lazily-loaded file tree rooted at `root`.
 * Used by both the Explorer view and the per-project inspector panel.
 */
export default function FileTree({
  root,
  showHidden = false,
  selectedPath,
  onOpenFile,
  onReveal,
}: {
  root: string;
  showHidden?: boolean;
  /** Highlight the currently-viewed file (optional). */
  selectedPath?: string | null;
  onOpenFile: (entry: DirEntry) => void;
  onReveal?: (entry: DirEntry) => void;
}) {
  return (
    <DirChildren
      key={root}
      path={root}
      depth={0}
      showHidden={showHidden}
      selectedPath={selectedPath ?? null}
      onOpenFile={onOpenFile}
      onReveal={onReveal}
    />
  );
}

function DirChildren({
  path,
  depth,
  showHidden,
  selectedPath,
  onOpenFile,
  onReveal,
}: {
  path: string;
  depth: number;
  showHidden: boolean;
  selectedPath: string | null;
  onOpenFile: (entry: DirEntry) => void;
  onReveal?: (entry: DirEntry) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    readDir(path)
      .then((e) => !cancelled && setEntries(e))
      .catch((e) => !cancelled && setError(typeof e === "string" ? e : String(e)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const pad = { paddingLeft: depth * 16 + 8 } as const;

  if (error) {
    return (
      <p className="px-2 py-1 text-xs text-rose-300/80" style={pad}>
        {error}
      </p>
    );
  }
  if (!entries) {
    return (
      <p className="px-2 py-1 text-xs text-slate-600" style={pad}>
        Loading…
      </p>
    );
  }

  const visible = entries.filter((e) => showHidden || !e.hidden);
  if (visible.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-slate-600" style={pad}>
        Empty folder
      </p>
    );
  }

  return (
    <>
      {visible.map((entry) => (
        <Node
          key={entry.path}
          entry={entry}
          depth={depth}
          showHidden={showHidden}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onReveal={onReveal}
        />
      ))}
    </>
  );
}

function Node({
  entry,
  depth,
  showHidden,
  selectedPath,
  onOpenFile,
  onReveal,
}: {
  entry: DirEntry;
  depth: number;
  showHidden: boolean;
  selectedPath: string | null;
  onOpenFile: (entry: DirEntry) => void;
  onReveal?: (entry: DirEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSelected = !entry.isDir && selectedPath === entry.path;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md py-1 pr-2 ${
          isSelected ? "bg-accent/15" : "hover:bg-surface-hover"
        } ${entry.hidden ? "opacity-60" : ""}`}
        style={{ paddingLeft: depth * 16 + 6 }}
      >
        <button
          onClick={() => (entry.isDir ? setOpen((o) => !o) : onOpenFile(entry))}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="w-3.5 shrink-0 text-slate-600">
            {entry.isDir &&
              (open ? (
                <ChevronDownIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronRightIcon className="h-3.5 w-3.5" />
              ))}
          </span>
          {entry.isDir ? (
            <FolderIcon className="h-4 w-4 shrink-0 text-accent-soft" />
          ) : (
            <FileIcon className="h-4 w-4 shrink-0 text-slate-500" />
          )}
          <span
            className={`truncate text-sm ${
              isSelected ? "text-accent-soft" : "text-slate-200"
            }`}
          >
            {entry.name}
          </span>
        </button>
        {onReveal && (
          <button
            onClick={() => onReveal(entry)}
            title={entry.isDir ? revealLabel : "Open file externally"}
            className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition-opacity hover:text-slate-200 group-hover:opacity-100"
          >
            <FolderIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {entry.isDir && open && (
        <DirChildren
          path={entry.path}
          depth={depth + 1}
          showHidden={showHidden}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onReveal={onReveal}
        />
      )}
    </div>
  );
}
