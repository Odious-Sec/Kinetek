import { useCallback, useEffect, useState } from "react";
import type { DirEntry } from "../types";
import { homeDir, openInFileManager, pickDirectory } from "../lib/tauri";
import FileBrowser from "./FileBrowser";
import { FolderIcon, HomeIcon, RefreshIcon } from "./icons";

interface Props {
  /** Preferred starting folder (e.g. Settings → default location). */
  initialRoot: string;
  notify: (kind: "ok" | "err", message: string) => void;
}

/**
 * A read-only visual file tree — Kinetek as a development-first file finder.
 * It only *reads* the disk (lazily, folder by folder); nothing is moved or
 * created here.
 */
export default function Explorer({ initialRoot, notify }: Props) {
  const [root, setRoot] = useState(initialRoot);
  const [showHidden, setShowHidden] = useState(false);
  // Bump to force the tree to remount (a simple "refresh").
  const [treeKey, setTreeKey] = useState(0);

  // Resolve a starting root if none was provided.
  useEffect(() => {
    if (root) return;
    homeDir()
      .then((h) => h && setRoot(h))
      .catch(() => {});
  }, [root]);

  const open = useCallback(
    async (entry: DirEntry) => {
      try {
        await openInFileManager(entry.path);
      } catch (e) {
        notify("err", typeof e === "string" ? e : String(e));
      }
    },
    [notify]
  );

  async function changeRoot() {
    const dir = await pickDirectory("Choose a folder to browse");
    if (dir) {
      setRoot(dir);
      setTreeKey((k) => k + 1);
    }
  }

  async function goHome() {
    const h = await homeDir();
    if (h) {
      setRoot(h);
      setTreeKey((k) => k + 1);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="shrink-0 px-8 pt-8">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Explorer</h1>
        <p className="mt-1 text-sm text-slate-500">Browse your files like a finder.</p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            onClick={goHome}
            title="Go to your home folder"
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
          >
            <HomeIcon className="h-4 w-4" />
            Home
          </button>
          <button
            onClick={changeRoot}
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
          >
            <FolderIcon className="h-4 w-4" />
            Choose folder
          </button>
          <button
            onClick={() => setTreeKey((k) => k + 1)}
            title="Refresh"
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
          >
            <RefreshIcon className="h-4 w-4" />
          </button>
          <label className="ml-1 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Show hidden files
          </label>
        </div>

        <p className="mt-3 truncate font-mono text-xs text-slate-500" title={root}>
          {root || "Resolving…"}
        </p>
      </header>

      {/* Tree / search */}
      <main className="min-h-0 flex-1 px-6 pb-6 pt-4">
        {root ? (
          <div className="flex h-full flex-col rounded-xl border border-surface-border bg-surface-card/40 p-2">
            <FileBrowser
              key={`${root}:${treeKey}`}
              root={root}
              showHidden={showHidden}
              onOpenFile={open}
              onReveal={open}
            />
          </div>
        ) : (
          <p className="px-2 text-sm text-slate-500">Pick a folder to start browsing.</p>
        )}
      </main>
    </div>
  );
}
