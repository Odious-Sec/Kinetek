import { useCallback, useEffect, useState } from "react";
import type { GitChange, GitStatus, Project } from "../types";
import {
  GITHUB_TOKEN_KEY,
  deleteSecret,
  getSecret,
  gitChanges,
  gitCommit,
  gitFetch,
  gitInit,
  gitPull,
  gitPush,
  gitRemote,
  gitRemoveRemote,
  gitSetRemote,
  gitStatus,
  openUrl,
  setSecret,
} from "../lib/tauri";
import {
  createGithubRepo,
  deleteGithubRepo,
  getGithubRepo,
  getGithubUser,
  listGithubRepos,
  setGithubRepoVisibility,
  type GithubRepo,
} from "../lib/github";
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  KeyIcon,
  LockIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  UnlockIcon,
  UploadIcon,
} from "./icons";

interface Props {
  project: Project;
  notify: (kind: "ok" | "err", message: string) => void;
  /** When provided, changed files become clickable (drives a diff pane). */
  selectedChange?: string | null;
  onSelectChange?: (path: string) => void;
}

/** Source control + GitHub account connection for one project. */
export default function GitPanel({ project, notify, selectedChange, onSelectChange }: Props) {
  const [status, setStatus] = useState<GitStatus | null | "loading">("loading");
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [remote, setRemote] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Connected repo metadata (for visibility + delete).
  const [repoInfo, setRepoInfo] = useState<GithubRepo | null>(null);
  const [visBusy, setVisBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Token (null = loading, "" = none).
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingToken, setEditingToken] = useState(false);

  // GitHub account.
  const [ghUser, setGhUser] = useState<string | null | "loading" | "invalid">(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");
  const [showConnect, setShowConnect] = useState<"none" | "link" | "create">("none");
  const [newName, setNewName] = useState(project.name);
  const [newPrivate, setNewPrivate] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, c, r] = await Promise.all([
        gitStatus(project.path),
        gitChanges(project.path).catch(() => []),
        gitRemote(project.path).catch(() => null),
      ]);
      setStatus(s);
      setChanges(c);
      setRemote(r);
    } catch {
      setStatus(null);
    }
  }, [project.path]);

  useEffect(() => {
    setStatus("loading");
    setMessage("");
    setShowConnect("none");
    setNewName(project.name);
    setConfirmingDelete(false);
    setRepoInfo(null);
    refresh();
    getSecret(GITHUB_TOKEN_KEY)
      .then((t) => setToken(t ?? ""))
      .catch(() => setToken(""));
  }, [project.path, project.name, refresh]);

  // Once connected with a valid token, fetch the repo's visibility metadata.
  useEffect(() => {
    if (!remote || !token || ghUser === "invalid" || ghUser === "loading" || ghUser === null) {
      setRepoInfo(null);
      return;
    }
    let cancelled = false;
    getGithubRepo(token, remote)
      .then((r) => !cancelled && setRepoInfo(r))
      .catch(() => !cancelled && setRepoInfo(null));
    return () => {
      cancelled = true;
    };
  }, [remote, token, ghUser]);

  // Validate the token → show the connected account.
  useEffect(() => {
    if (token === null) return;
    if (!token) {
      setGhUser(null);
      return;
    }
    let cancelled = false;
    setGhUser("loading");
    getGithubUser(token)
      .then((u) => !cancelled && setGhUser(u.login))
      .catch(() => !cancelled && setGhUser("invalid"));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function saveToken() {
    const t = draft.trim();
    if (!t) return;
    try {
      await setSecret(GITHUB_TOKEN_KEY, t);
      setToken(t);
      setDraft("");
      setEditingToken(false);
      notify("ok", "GitHub token saved.");
    } catch (e) {
      notify("err", asMsg(e));
    }
  }

  async function removeToken() {
    try {
      await deleteSecret(GITHUB_TOKEN_KEY);
      setToken("");
      setGhUser(null);
      notify("ok", "Removed the GitHub token.");
    } catch (e) {
      notify("err", asMsg(e));
    }
  }

  async function loadRepos() {
    if (!token) return;
    setReposLoading(true);
    try {
      setRepos(await listGithubRepos(token));
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setReposLoading(false);
    }
  }

  async function ensureRepo(): Promise<boolean> {
    // Make sure there's a git repo before setting a remote.
    if (status === null) {
      await gitInit(project.path);
      await refresh();
    }
    return true;
  }

  async function linkRepo(repo: GithubRepo) {
    setBusy(true);
    try {
      await ensureRepo();
      await gitSetRemote(project.path, repo.cloneUrl);
      setShowConnect("none");
      notify("ok", `Connected to ${repo.fullName}.`);
      await refresh();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function createRepo() {
    if (!token || !newName.trim()) return;
    setBusy(true);
    try {
      await ensureRepo();
      const repo = await createGithubRepo(token, newName.trim(), newPrivate);
      await gitSetRemote(project.path, repo.cloneUrl);
      setShowConnect("none");
      notify("ok", `Created and connected ${repo.fullName}.`);
      await refresh();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function commitAndPush() {
    setBusy(true);
    try {
      if (changes.length > 0) await gitCommit(project.path, message);
      await gitPush(project.path, token ?? "");
      setMessage("");
      notify("ok", `Pushed ${project.name} to GitHub.`);
      await refresh();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function pushOnly() {
    setBusy(true);
    try {
      await gitPush(project.path, token ?? "");
      notify("ok", `Pushed ${project.name} to GitHub.`);
      await refresh();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // Refresh remote-tracking refs (so the behind count updates) without changing
  // any local files.
  async function fetchRemote() {
    setBusy(true);
    try {
      await gitFetch(project.path, token ?? "");
      await refresh();
      notify("ok", "Fetched from origin.");
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // Fast-forward pull the current branch from origin.
  async function pull() {
    setBusy(true);
    try {
      await gitPull(project.path, token ?? "");
      notify("ok", `Pulled the latest into ${project.name}.`);
      await refresh();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleVisibility() {
    if (!token || !remote || !repoInfo) return;
    setVisBusy(true);
    try {
      const updated = await setGithubRepoVisibility(token, remote, !repoInfo.private);
      setRepoInfo(updated);
      notify("ok", `${remote} is now ${updated.private ? "private" : "public"}.`);
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setVisBusy(false);
    }
  }

  // Delete the repo on GitHub but keep the local files + history.
  async function deleteRemoteRepo() {
    if (!token || !remote) return;
    setDeleteBusy(true);
    try {
      await deleteGithubRepo(token, remote);
      await gitRemoveRemote(project.path);
      setConfirmingDelete(false);
      setRepoInfo(null);
      notify("ok", `Deleted ${remote} on GitHub. Your local files are untouched.`);
      await refresh();
    } catch (e) {
      notify("err", asMsg(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (status === "loading" || token === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-slate-600">
        <RefreshIcon className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const tokenSaved = token.length > 0 && !editingToken;
  const isRepo = status !== null;
  const dirty = changes.length > 0;
  const ahead = isRepo ? status.ahead : 0;
  const behind = isRepo ? status.behind : 0;

  return (
    <div className="flex h-full flex-col">
      {/* GitHub account */}
      <div className="shrink-0 border-b border-surface-border px-3 py-2">
        {tokenSaved ? (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <KeyIcon className="h-3.5 w-3.5 text-emerald-300" />
            {ghUser === "loading" ? (
              "Checking token…"
            ) : ghUser === "invalid" ? (
              <span className="text-rose-300">Token invalid or lacks `repo` scope</span>
            ) : (
              <span className="text-slate-300">Connected as @{ghUser}</span>
            )}
            <button
              onClick={() => {
                setEditingToken(true);
                setDraft("");
              }}
              className="ml-auto text-slate-500 hover:text-slate-300"
            >
              Change
            </button>
            <button onClick={removeToken} className="text-slate-500 hover:text-rose-300">
              Remove
            </button>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <KeyIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <input
                type="password"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="GitHub personal access token"
                spellCheck={false}
                className="w-full rounded-lg border border-surface-border bg-surface-base px-2.5 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent/60"
              />
              <button
                onClick={saveToken}
                disabled={!draft.trim()}
                className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:bg-accent-glow disabled:opacity-40"
              >
                Save
              </button>
            </div>
            <button
              onClick={() =>
                openUrl("https://github.com/settings/tokens/new?scopes=repo&description=Kinetek")
              }
              className="mt-1.5 inline-flex items-center gap-0.5 text-[11px] text-accent-soft hover:underline"
            >
              Create a classic token (tick the `repo` scope){" "}
              <ExternalLinkIcon className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {/* Repo / connection state */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Branch + remote summary */}
        <div className="border-b border-surface-border px-3 py-2 text-xs">
          {isRepo ? (
            <>
              <div className="flex items-center gap-1.5 font-mono text-slate-300">
                <GitBranchIcon className="h-3.5 w-3.5 text-slate-500" />
                {status.branch}
                {(ahead > 0 || behind > 0) && (
                  <span className="text-slate-500">
                    {ahead > 0 && `↑${ahead}`}{" "}
                    {behind > 0 && `↓${behind}`}
                  </span>
                )}
                {remote && (
                  <button
                    onClick={fetchRemote}
                    disabled={busy}
                    title="Fetch from origin (updates the ahead/behind counts; doesn't change your files)"
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-card px-1.5 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200 disabled:opacity-50"
                  >
                    <RefreshIcon className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} /> Fetch
                  </button>
                )}
              </div>
              <div className="truncate text-slate-500">
                {remote ? `→ ${remote}` : "Not connected to a GitHub repo yet"}
              </div>
              {behind > 0 && (
                <p className="mt-1 text-[11px] text-amber-300/90">
                  {behind} commit{behind === 1 ? "" : "s"} on origin you don't have — pull to catch up.
                </p>
              )}

              {/* Visibility + delete controls for the connected repo */}
              {remote && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {repoInfo && (
                    <button
                      onClick={toggleVisibility}
                      disabled={visBusy}
                      title={`Make ${repoInfo.private ? "public" : "private"}`}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:bg-surface-hover disabled:opacity-50"
                    >
                      {visBusy ? (
                        <RefreshIcon className="h-3 w-3 animate-spin" />
                      ) : repoInfo.private ? (
                        <LockIcon className="h-3 w-3 text-amber-300" />
                      ) : (
                        <UnlockIcon className="h-3 w-3 text-emerald-300" />
                      )}
                      {repoInfo.private ? "Private" : "Public"}
                      <span className="text-slate-500">· make {repoInfo.private ? "public" : "private"}</span>
                    </button>
                  )}
                  {repoInfo?.htmlUrl && (
                    <button
                      onClick={() => openUrl(repoInfo.htmlUrl)}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:bg-surface-hover"
                    >
                      <ExternalLinkIcon className="h-3 w-3" /> Open
                    </button>
                  )}
                  {!confirmingDelete ? (
                    <button
                      onClick={() => setConfirmingDelete(true)}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                    >
                      <TrashIcon className="h-3 w-3" /> Delete repo
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                      Delete on GitHub? (local files kept)
                      <button
                        onClick={deleteRemoteRepo}
                        disabled={deleteBusy}
                        className="font-semibold text-rose-300 hover:underline disabled:opacity-50"
                      >
                        {deleteBusy ? "Deleting…" : "Yes"}
                      </button>
                      <button
                        onClick={() => setConfirmingDelete(false)}
                        disabled={deleteBusy}
                        className="text-slate-400 hover:text-slate-200"
                      >
                        Cancel
                      </button>
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Not a git repository.</span>
            </div>
          )}
        </div>

        {/* Connect section (no remote yet) */}
        {!remote && (
          <div className="space-y-2 border-b border-surface-border px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              Connect to GitHub
            </p>
            {!token || ghUser === "invalid" ? (
              <p className="text-xs text-slate-500">
                Add a valid token above to link or create a repo.
              </p>
            ) : showConnect === "none" ? (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowConnect("link");
                    if (repos === null) loadRepos();
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-xs font-medium text-slate-200 hover:bg-surface-hover"
                >
                  <GitBranchIcon className="h-3.5 w-3.5" />
                  Link existing
                </button>
                <button
                  onClick={() => setShowConnect("create")}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-glow"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Create new
                </button>
              </div>
            ) : showConnect === "link" ? (
              <div className="space-y-2">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    value={repoFilter}
                    onChange={(e) => setRepoFilter(e.target.value)}
                    placeholder="Filter your repos…"
                    className="w-full rounded-lg border border-surface-border bg-surface-base py-1.5 pl-8 pr-2 text-xs text-slate-100 outline-none focus:border-accent/50"
                  />
                </div>
                <div className="max-h-44 space-y-0.5 overflow-auto">
                  {reposLoading && <p className="px-1 py-1 text-xs text-slate-600">Loading repos…</p>}
                  {repos
                    ?.filter((r) =>
                      r.fullName.toLowerCase().includes(repoFilter.trim().toLowerCase())
                    )
                    .map((r) => (
                      <button
                        key={r.fullName}
                        onClick={() => linkRepo(r)}
                        disabled={busy}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-hover disabled:opacity-50"
                      >
                        <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <span className="flex-1 truncate text-slate-200">{r.fullName}</span>
                        {r.private && <span className="text-[10px] text-slate-600">private</span>}
                      </button>
                    ))}
                  {repos && repos.length === 0 && (
                    <p className="px-1 py-1 text-xs text-slate-600">No repositories found.</p>
                  )}
                </div>
                <button
                  onClick={() => setShowConnect("none")}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Back
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="new-repo-name"
                  spellCheck={false}
                  className="w-full rounded-lg border border-surface-border bg-surface-base px-2.5 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-accent/60"
                />
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                  <input
                    type="checkbox"
                    checked={newPrivate}
                    onChange={(e) => setNewPrivate(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  Private repository
                </label>
                <p className="text-[11px] text-slate-600">
                  Creating a repo needs a classic token with the `repo` scope.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={createRepo}
                    disabled={busy || !newName.trim()}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-glow disabled:opacity-40"
                  >
                    {busy ? "Creating…" : "Create & connect"}
                  </button>
                  <button
                    onClick={() => setShowConnect("none")}
                    className="rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-xs font-medium text-slate-200 hover:bg-surface-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {status === null && token && ghUser !== "invalid" && (
              <p className="text-[11px] text-slate-600">
                This folder will be initialized as a git repo when you connect.
              </p>
            )}
          </div>
        )}

        {/* Changes */}
        {isRepo && (
          <div className="px-3 py-2">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
              Changes {dirty && `(${changes.length})`}
            </p>
            {dirty ? (
              <div className="space-y-0.5">
                {changes.map((c) =>
                  onSelectChange ? (
                    <button
                      key={c.path}
                      onClick={() => onSelectChange(c.path)}
                      className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${
                        selectedChange === c.path ? "bg-accent/15" : "hover:bg-surface-hover"
                      }`}
                    >
                      <span className="w-16 shrink-0 text-[10px] uppercase text-slate-500">
                        {c.status}
                      </span>
                      <span className="truncate font-mono text-slate-300" title={c.path}>
                        {c.path}
                      </span>
                    </button>
                  ) : (
                    <div key={c.path} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 text-[10px] uppercase text-slate-500">
                        {c.status}
                      </span>
                      <span className="truncate font-mono text-slate-300" title={c.path}>
                        {c.path}
                      </span>
                    </div>
                  )
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-600">
                {ahead > 0
                  ? `Nothing to commit. ${ahead} commit${ahead === 1 ? "" : "s"} ready to push.`
                  : "Nothing to commit — working tree clean."}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Commit + push */}
      {isRepo && (
        <div className="shrink-0 space-y-2 border-t border-surface-border p-3">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Commit message…"
            disabled={!dirty}
            className="w-full resize-none rounded-lg border border-surface-border bg-surface-base px-2.5 py-2 text-xs text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60 disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={commitAndPush}
              disabled={busy || !dirty || !message.trim() || !remote}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CheckIcon className="h-3.5 w-3.5" />
              {busy ? "Working…" : "Commit & Push"}
            </button>
            <button
              onClick={pull}
              disabled={busy || !remote}
              title="Pull the latest from origin (fast-forward only)"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              Pull{behind > 0 ? ` ↓${behind}` : ""}
            </button>
            <button
              onClick={pushOnly}
              disabled={busy || !remote || (ahead === 0 && !dirty)}
              title="Push already-committed changes"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <UploadIcon className="h-3.5 w-3.5" />
              Push{ahead > 0 ? ` ↑${ahead}` : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function asMsg(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
