import { useEffect, useState } from "react";
import { gitDiff } from "../lib/tauri";
import { GitCompareIcon, RefreshIcon } from "./icons";

/**
 * Shows local changes as a coloured unified diff — what's changed in the working
 * tree versus the last commit (i.e. versus what GitHub has). Pass a `file` to
 * scope it to one path, or null for the whole working tree.
 */
export default function DiffViewer({
  path,
  file,
}: {
  path: string;
  file: string | null;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDiff(null);
    gitDiff(path, file ?? undefined)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(typeof e === "string" ? e : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, file]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-600">
        <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Loading diff…
      </div>
    );
  }
  if (error) {
    return <p className="p-4 text-xs text-rose-300/80">{error}</p>;
  }
  if (!diff || diff.trim() === "") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-slate-600">
        <GitCompareIcon className="h-6 w-6 text-slate-700" />
        <p>{file ? "No changes in this file." : "No local changes — your working tree matches the last commit."}</p>
      </div>
    );
  }

  const lines = diff.split("\n");

  return (
    <div className="h-full overflow-auto bg-surface-base">
      <pre data-selectable="true" className="min-w-full p-3 font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => {
          let cls = "text-slate-400";
          if (line.startsWith("+++") || line.startsWith("---")) cls = "text-slate-500";
          else if (line.startsWith("@@")) cls = "text-accent-soft";
          else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file"))
            cls = "text-slate-600";
          else if (line.startsWith("+")) cls = "bg-emerald-500/10 text-emerald-300";
          else if (line.startsWith("-")) cls = "bg-rose-500/10 text-rose-300";
          else cls = "text-slate-400";
          return (
            <div key={i} className={`whitespace-pre-wrap break-words px-1 ${cls}`}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
