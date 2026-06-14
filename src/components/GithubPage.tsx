import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../types";
import {
  GITHUB_TOKEN_KEY,
  deleteSecret,
  getSecret,
  gitClone,
  isTauri,
  openUrl,
  pickDirectory,
  setSecret,
} from "../lib/tauri";
import { getGithubUser, listAllGithubRepos, type GithubRepo } from "../lib/github";
import {
  CheckIcon,
  CloudDownloadIcon,
  ExternalLinkIcon,
  GithubIcon,
  KeyIcon,
  RefreshIcon,
  SearchIcon,
  StarIcon,
} from "./icons";

interface Props {
  notify: (kind: "ok" | "err", message: string) => void;
  defaultDir: string | null;
  /** Folder names already on disk as projects, to mark repos as "saved". */
  localNames: Set<string>;
  onCloned: (project: Project) => void;
}

function asMsg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  const units: [number, string][] = [
    [60, "s"], [60, "m"], [24, "h"], [7, "d"], [4.35, "w"], [12, "mo"], [Infinity, "y"],
  ];
  let v = secs;
  let label = "s";
  for (const [step, l] of units) {
    if (v < step) { label = l; break; }
    v = Math.floor(v / step);
    label = l;
  }
  return `${v}${label} ago`;
}

/**
 * The GitHub page: connect an account, browse EVERY repo you can access, and
 * save any of them to disk (clone) as a Kinetek project.
 */
export default function GithubPage({ notify, defaultDir, localNames, onCloned }: Props) {
  const [token, setToken] = useState<string | null>(null); // null=loading, ""=none
  const [draft, setDraft] = useState("");
  const [ghUser, setGhUser] = useState<string | null | "loading" | "invalid">(null);

  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [cloning, setCloning] = useState<string | null>(null); // fullName in progress
  const [cloned, setCloned] = useState<Set<string>>(new Set());

  useEffect(() => {
    getSecret(GITHUB_TOKEN_KEY)
      .then((t) => setToken(t ?? ""))
      .catch(() => setToken(""));
  }, []);

  const loadRepos = useCallback(
    async (t: string) => {
      setLoading(true);
      try {
        setRepos(await listAllGithubRepos(t));
      } catch (e) {
        notify("err", asMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [notify]
  );

  // Validate token → user, then load repos.
  useEffect(() => {
    if (!token) {
      setGhUser(null);
      setRepos(null);
      return;
    }
    let cancelled = false;
    setGhUser("loading");
    getGithubUser(token)
      .then((u) => {
        if (cancelled) return;
        setGhUser(u.login);
        loadRepos(token);
      })
      .catch(() => !cancelled && setGhUser("invalid"));
    return () => {
      cancelled = true;
    };
  }, [token, loadRepos]);

  async function saveToken() {
    const t = draft.trim();
    if (!t) return;
    try {
      await setSecret(GITHUB_TOKEN_KEY, t);
      setToken(t);
      setDraft("");
      notify("ok", "GitHub token saved.");
    } catch (e) {
      notify("err", asMsg(e));
    }
  }

  async function removeToken() {
    try {
      await deleteSecret(GITHUB_TOKEN_KEY);
      setToken("");
      notify("ok", "Removed the GitHub token.");
    } catch (e) {
      notify("err", asMsg(e));
    }
  }

  async function saveLocally(repo: GithubRepo) {
    if (!isTauri()) {
      notify("err", "Cloning is only available in the desktop app.");
      return;
    }
    const dest =
      defaultDir ||
      (await pickDirectory("Choose where to save this repository"));
    if (!dest) return;
    setCloning(repo.fullName);
    try {
      const project = await gitClone(repo.cloneUrl, dest, token ?? "");
      // Carry over the GitHub description as the plain-English summary.
      onCloned({ ...project, summary: repo.description ?? project.summary });
      setCloned((s) => new Set(s).add(repo.fullName));
      notify("ok", `Saved ${repo.name} to ${dest}.`);
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setCloning(null);
    }
  }

  const visible = useMemo(() => {
    if (!repos) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        (r.language ?? "").toLowerCase().includes(q)
    );
  }, [repos, filter]);

  // --- Not connected: token entry ---
  if (token === "" || ghUser === "invalid") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-raised p-6">
          <div className="mb-3 flex items-center gap-2 text-slate-100">
            <GithubIcon className="h-5 w-5" />
            <h2 className="text-base font-semibold">Connect GitHub</h2>
          </div>
          <p className="mb-4 text-sm text-slate-400">
            Paste a personal access token to browse and save all your
            repositories. {ghUser === "invalid" && (
              <span className="text-rose-300">
                That token was rejected — make sure it's a classic token with the{" "}
                <code>repo</code> scope.
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <KeyIcon className="h-4 w-4 shrink-0 text-slate-500" />
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveToken()}
              placeholder="GitHub personal access token"
              spellCheck={false}
              className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent/60"
            />
            <button
              onClick={saveToken}
              disabled={!draft.trim()}
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-glow disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <button
            onClick={() =>
              openUrl("https://github.com/settings/tokens/new?scopes=repo&description=Kinetek")
            }
            className="mt-3 inline-flex items-center gap-1 text-xs text-accent-soft hover:underline"
          >
            Create a classic token (tick the <code>repo</code> scope){" "}
            <ExternalLinkIcon className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-surface-border px-5 py-3">
        <div className="flex items-center gap-2">
          <GithubIcon className="h-5 w-5 text-slate-200" />
          <h1 className="text-base font-semibold text-slate-100">GitHub</h1>
          {ghUser && ghUser !== "loading" && (
            <span className="rounded-full bg-surface-card px-2 py-0.5 text-xs text-slate-400">
              @{ghUser}
            </span>
          )}
          {repos && (
            <span className="text-xs text-slate-600">{repos.length} repos</span>
          )}
          <button
            onClick={() => token && loadRepos(token)}
            title="Refresh"
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-surface-hover hover:text-slate-200"
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={removeToken}
            className="text-xs text-slate-500 hover:text-rose-300"
          >
            Disconnect
          </button>
        </div>
        <div className="relative mt-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, description or language…"
            className="w-full rounded-lg border border-surface-border bg-surface-base py-2 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-accent/50"
          />
        </div>
      </div>

      {/* Repo list */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading && !repos ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">
            <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Loading your repositories…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">
            {repos && repos.length > 0 ? "No repos match your filter." : "No repositories found."}
          </div>
        ) : (
          <ul className="mx-auto grid max-w-5xl gap-2.5">
            {visible.map((r) => {
              const saved = cloned.has(r.fullName) || localNames.has(r.name);
              const busy = cloning === r.fullName;
              return (
                <li
                  key={r.fullName}
                  className="flex items-start gap-3 rounded-xl border border-surface-border bg-surface-card px-4 py-3 transition-colors hover:border-accent/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => r.htmlUrl && openUrl(r.htmlUrl)}
                        className="truncate text-sm font-medium text-slate-100 hover:text-accent-soft"
                        title="Open on GitHub"
                      >
                        {r.fullName}
                      </button>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          r.private
                            ? "bg-amber-400/10 text-amber-300"
                            : "bg-emerald-400/10 text-emerald-300"
                        }`}
                      >
                        {r.private ? "private" : "public"}
                      </span>
                      {r.fork && (
                        <span className="shrink-0 text-[10px] text-slate-600">fork</span>
                      )}
                    </div>
                    {r.description && (
                      <p className="mt-0.5 truncate text-xs text-slate-400">{r.description}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-600">
                      {r.language && (
                        <span className="flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-accent/70" />
                          {r.language}
                        </span>
                      )}
                      {r.stars > 0 && (
                        <span className="flex items-center gap-1">
                          <StarIcon className="h-3 w-3" /> {r.stars}
                        </span>
                      )}
                      {r.updatedAt && <span>updated {relativeTime(r.updatedAt)}</span>}
                    </div>
                  </div>
                  {saved ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
                      <CheckIcon className="h-3.5 w-3.5" /> Saved
                    </span>
                  ) : (
                    <button
                      onClick={() => saveLocally(r)}
                      disabled={busy}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-surface-border bg-surface-base px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:opacity-50"
                    >
                      {busy ? (
                        <>
                          <RefreshIcon className="h-3.5 w-3.5 animate-spin" /> Saving…
                        </>
                      ) : (
                        <>
                          <CloudDownloadIcon className="h-3.5 w-3.5" /> Save locally
                        </>
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
