import { useEffect, useState } from "react";
import type { DirEntry, SearchHit } from "../types";
import { searchFiles } from "../lib/tauri";
import FileTree from "./FileTree";
import { FileIcon, FolderIcon, SearchIcon, XIcon } from "./icons";

interface Props {
  root: string;
  showHidden?: boolean;
  selectedPath?: string | null;
  /** Open a file (preview inline, or externally — caller decides). */
  onOpenFile: (entry: DirEntry) => void;
  /** Reveal in Finder / open externally. */
  onReveal?: (entry: DirEntry) => void;
}

/**
 * A search box over a file tree. Empty query shows the lazy tree; a query shows
 * a flat list of matches found recursively under `root`.
 */
export default function FileBrowser({
  root,
  showHidden = false,
  selectedPath,
  onOpenFile,
  onReveal,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Reset when the root changes (e.g. switching projects/folders).
  useEffect(() => {
    setQuery("");
    setResults(null);
  }, [root]);

  // Debounced recursive search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchFiles(root, q)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false));
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, root]);

  const toEntry = (h: SearchHit): DirEntry => ({
    name: h.name,
    path: h.path,
    isDir: h.isDir,
    hidden: h.name.startsWith("."),
  });

  return (
    <div className="flex h-full flex-col">
      {/* Search */}
      <div className="relative shrink-0 px-1 pb-2">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files…"
          spellCheck={false}
          className="w-full rounded-lg border border-surface-border bg-surface-base py-1.5 pl-8 pr-7 text-xs text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/50"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Tree or results */}
      <div className="min-h-0 flex-1 overflow-auto">
        {results === null ? (
          <FileTree
            root={root}
            showHidden={showHidden}
            selectedPath={selectedPath}
            onOpenFile={onOpenFile}
            onReveal={onReveal}
          />
        ) : searching && results.length === 0 ? (
          <p className="px-2 py-2 text-xs text-slate-600">Searching…</p>
        ) : results.length === 0 ? (
          <p className="px-2 py-2 text-xs text-slate-600">No matches.</p>
        ) : (
          <div className="space-y-0.5">
            {results.map((hit) => {
              const isSelected = !hit.isDir && selectedPath === hit.path;
              return (
                <div
                  key={hit.path}
                  className={`group flex items-center gap-2 rounded-md px-2 py-1 ${
                    isSelected ? "bg-accent/15" : "hover:bg-surface-hover"
                  }`}
                >
                  <button
                    onClick={() => onOpenFile(toEntry(hit))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    title={hit.rel}
                  >
                    {hit.isDir ? (
                      <FolderIcon className="h-4 w-4 shrink-0 text-accent-soft" />
                    ) : (
                      <FileIcon className="h-4 w-4 shrink-0 text-slate-500" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm ${
                          isSelected ? "text-accent-soft" : "text-slate-200"
                        }`}
                      >
                        {hit.name}
                      </span>
                      <span className="block truncate text-[10px] text-slate-600">
                        {hit.rel}
                      </span>
                    </span>
                  </button>
                  {onReveal && (
                    <button
                      onClick={() => onReveal(toEntry(hit))}
                      title="Open in Finder"
                      className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition-opacity hover:text-slate-200 group-hover:opacity-100"
                    >
                      <FolderIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
