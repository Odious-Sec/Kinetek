/**
 * Thin, typed wrapper around the Rust backend commands.
 *
 * Centralizing `invoke` calls here means components never touch the raw
 * Tauri API and we get one place to evolve the contract.
 */
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { record } from "./logStore";
import type {
  CreateProjectArgs,
  DirEntry,
  FileContent,
  GeneratedFile,
  GitChange,
  GitStatus,
  Organization,
  Prerequisite,
  PreviewInfo,
  PreviewStatus,
  ApiCall,
  Commit,
  Diagnostic,
  Endpoint,
  GitRefs,
  Project,
  ProjectContext,
  SearchHit,
  StashEntry,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";

/** Are we actually running inside the Tauri webview? */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Scan a directory one level deep and return detected projects. */
export async function scanProjects(dir: string): Promise<Project[]> {
  return invoke<Project[]>("scan_projects", { dir });
}

/**
 * Bootstrap a new project by running the template's framework CLI.
 * Resolves with the created project's card metadata, or rejects with a
 * human-readable error string surfaced by the backend.
 */
export async function createProject(args: CreateProjectArgs): Promise<Project> {
  return invoke<Project>("create_project", { ...args });
}

/** Check whether the tools a template needs are installed. */
export async function checkPrerequisites(
  templateId: string
): Promise<Prerequisite[]> {
  return invoke<Prerequisite[]>("check_prerequisites", { templateId });
}

/** Check a single tool from the catalog (e.g. "claude"). */
export async function checkTool(key: string): Promise<Prerequisite> {
  return invoke<Prerequisite>("check_tool", { key });
}

/** Claude Code permission mode: "plan" = safe/read-only, "acceptEdits" = can edit files. */
export type ClaudeMode = "plan" | "acceptEdits";

/**
 * Delegate a prompt to the installed Claude Code CLI in a project's directory.
 * Output streams via `claude-output` events; completion via `claude-done`
 * (both carry `runId`). Uses the user's own Claude Code auth — no Kinetek secret.
 */
export async function runClaudeAgent(
  runId: string,
  projectPath: string,
  prompt: string,
  mode: ClaudeMode,
  sessionId?: string
): Promise<void> {
  return invoke("run_claude_agent", { runId, projectPath, prompt, mode, sessionId });
}

/** Stop a running Claude Code agent by run id. */
export async function stopClaude(runId: string): Promise<void> {
  return invoke("stop_claude", { runId });
}

/** Open an interactive PTY shell rooted at `cwd`. Output streams via
 *  `terminal-output` events; exit via `terminal-exit` (both carry the id). */
export async function terminalOpen(
  id: string,
  cwd: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("terminal_open", { id, cwd, cols, rows });
}

/** Send input/keystrokes to a terminal session. */
export async function terminalWrite(id: string, data: string): Promise<void> {
  return invoke("terminal_write", { id, data });
}

/** Resize a terminal session (after the xterm view is fitted). */
export async function terminalResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { id, cols, rows });
}

/** Close a terminal session and kill its shell. */
export async function terminalClose(id: string): Promise<void> {
  return invoke("terminal_close", { id });
}

/** Install a tool for the user via the platform package manager. */
export async function installTool(toolKey: string): Promise<void> {
  return invoke("install_tool", { toolKey });
}

/** Move a project folder to the system Trash (recoverable). */
export async function deleteProject(path: string): Promise<void> {
  return invoke("delete_project", { path });
}

/**
 * Permanently delete a project folder (NOT recoverable). Fallback for when
 * Trash fails (e.g. iCloud-evicted items Finder won't move).
 */
export async function deleteProjectPermanently(path: string): Promise<void> {
  return invoke("delete_project_permanently", { path });
}

/**
 * Write AI-generated files into a project. The backend rejects any path that
 * escapes the project folder. Resolves with the number of files written.
 */
export async function writeGeneratedFiles(
  projectPath: string,
  files: GeneratedFile[]
): Promise<number> {
  return invoke<number>("write_generated_files", { projectPath, files });
}

/** Open a URL in the user's default browser. */
export async function openUrl(url: string): Promise<void> {
  return openExternal(url);
}

/**
 * Record an error: pushes to the in-app log store immediately (real-time UI),
 * then appends to `kinetek-errors.log` in the background. Best-effort — never
 * throws; the file write is a no-op outside Tauri.
 */
export function logError(context: string, message: string): void {
  record("error", context, message);
  if (!isTauri()) return;
  // Fire-and-forget the on-disk write so the UI isn't blocked on it.
  invoke("log_error", {
    timestamp: new Date().toISOString(),
    context,
    message,
  }).catch(() => {
    /* logging must never break the app */
  });
}

/** Record an informational activity entry (in-app console only, not the file). */
export function logInfo(context: string, message: string): void {
  record("info", context, message);
}

/** Load the saved workspace (projects + folders + assignments + settings). */
export async function loadOrganization(): Promise<Organization> {
  if (!isTauri()) {
    return { projects: [], folders: [], assignments: {}, settings: DEFAULT_SETTINGS };
  }
  return invoke<Organization>("load_organization");
}

/** Persist the workspace. Best-effort outside Tauri (no-op). */
export async function saveOrganization(organization: Organization): Promise<void> {
  if (!isTauri()) return;
  return invoke("save_organization", { organization });
}

/** Store a secret (e.g. an AI API key) in the OS keychain. */
export async function setSecret(key: string, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

/** Read a secret from the OS keychain (null if unset / not in Tauri). */
export async function getSecret(key: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_secret", { key });
}

/** Delete a secret from the OS keychain. */
export async function deleteSecret(key: string): Promise<void> {
  if (!isTauri()) return;
  return invoke("delete_secret", { key });
}

/** Read a project's README + package.json for AI summarization. */
export async function readProjectContext(projectPath: string): Promise<ProjectContext> {
  return invoke<ProjectContext>("read_project_context", { projectPath });
}

/** Local git status for a project, or null if it isn't a git repo. */
export async function gitStatus(projectPath: string): Promise<GitStatus | null> {
  if (!isTauri()) return null;
  return invoke<GitStatus | null>("git_status", { projectPath });
}

/** Keychain entry name for the user's GitHub token. */
export const GITHUB_TOKEN_KEY = "github-token";

/** Uncommitted changes in a project. */
export async function gitChanges(path: string): Promise<GitChange[]> {
  return invoke<GitChange[]>("git_changes", { path });
}

/** Origin remote as "owner/repo", or null if none. */
export async function gitRemote(path: string): Promise<string | null> {
  return invoke<string | null>("git_remote", { path });
}

/** Stage all changes and commit with a message. */
export async function gitCommit(path: string, message: string): Promise<void> {
  return invoke("git_commit", { path, message });
}

/** Push the current branch to origin (token used for GitHub HTTPS auth). */
export async function gitPush(path: string, token: string): Promise<void> {
  return invoke("git_push", { path, token });
}

/** Fetch origin (updates `origin/*` refs; doesn't touch the working tree). */
export async function gitFetch(path: string, token: string): Promise<void> {
  return invoke("git_fetch", { path, token });
}

/** Pull the current branch from origin (fast-forward only). */
export async function gitPull(path: string, token: string): Promise<void> {
  return invoke("git_pull", { path, token });
}

/** Initialize a git repo in the project folder (if not already one). */
export async function gitInit(path: string): Promise<void> {
  return invoke("git_init", { path });
}

/** Point the project's `origin` remote at a repo URL. */
export async function gitSetRemote(path: string, url: string): Promise<void> {
  return invoke("git_set_remote", { path, url });
}

/** Read the commit history (all branches) for the visual graph. */
export async function gitLog(path: string, limit?: number): Promise<Commit[]> {
  return invoke<Commit[]>("git_log", { path, limit });
}

/**
 * Clone a GitHub repo into `dest` (a parent folder). Returns a project card for
 * the cloned folder. The token is used only for transport and is never saved.
 */
export async function gitClone(
  url: string,
  dest: string,
  token: string
): Promise<Project> {
  return invoke<Project>("git_clone", { url, dest, token });
}

/** Local changes as a unified diff (whole tree, or one file) vs the last commit. */
export async function gitDiff(path: string, file?: string): Promise<string> {
  return invoke<string>("git_diff", { path, file });
}

/** Remove the `origin` remote (after deleting the GitHub repo); keeps files. */
export async function gitRemoveRemote(path: string): Promise<void> {
  return invoke("git_remove_remote", { path });
}

/** Branches, remote-tracking branches, and tags for the refs sidebar. */
export async function gitRefs(path: string): Promise<GitRefs> {
  return invoke<GitRefs>("git_refs", { path });
}

/** Create a branch (optionally at a commit, optionally checking it out). */
export async function gitCreateBranch(
  path: string,
  name: string,
  at?: string,
  checkout = true
): Promise<void> {
  return invoke("git_create_branch", { path, name, at, checkout });
}

/** Switch to a branch/ref. */
export async function gitCheckout(path: string, reference: string): Promise<void> {
  return invoke("git_checkout", { path, reference });
}

/** Delete a local branch (force to discard unmerged commits). */
export async function gitDeleteBranch(
  path: string,
  name: string,
  force = false
): Promise<void> {
  return invoke("git_delete_branch", { path, name, force });
}

/** List saved stashes (most recent first). */
export async function gitStashes(path: string): Promise<StashEntry[]> {
  return invoke<StashEntry[]>("git_stashes", { path });
}

/** Stash the working tree (incl. untracked) so it isn't pushed yet. */
export async function gitStashSave(path: string, message?: string): Promise<void> {
  return invoke("git_stash_save", { path, message });
}

/** Apply a stash by index (pop also removes it from the list). */
export async function gitStashApply(path: string, index: number, pop: boolean): Promise<void> {
  return invoke("git_stash_apply", { path, index, pop });
}

/** Delete a stash by index. */
export async function gitStashDrop(path: string, index: number): Promise<void> {
  return invoke("git_stash_drop", { path, index });
}

/**
 * Open a project in the chosen editor ("vscode" | "cursor" | "zed" | "finder").
 * When `file` is given, `path` opens as the workspace and `file` is focused.
 */
export async function openInEditor(
  path: string,
  editor: string,
  file?: string
): Promise<void> {
  return invoke("open_in_editor", { path, editor, file });
}

/** List a folder's children for the visual Explorer (folders first). */
export async function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir", { path });
}

/** Absolute path to the user's home directory (default Explorer root). */
export async function homeDir(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("home_dir");
}

/** Read a file's text for the read-only viewer (flags binary/oversized). */
export async function readFileText(path: string): Promise<FileContent> {
  return invoke<FileContent>("read_file_text", { path });
}

/** Save UTF-8 text to a file (in-app editor). */
export async function writeFileText(path: string, content: string): Promise<void> {
  return invoke("write_file_text", { path, content });
}

/** On-save syntax check (Python/Go); empty when fine or unhandled by the backend. */
export async function checkSyntax(path: string): Promise<Diagnostic[]> {
  return invoke<Diagnostic[]>("check_syntax", { path });
}

/** Heuristically detect the HTTP routes an API exposes (for the API explorer). */
export async function detectEndpoints(path: string): Promise<Endpoint[]> {
  return invoke<Endpoint[]>("detect_endpoints", { path });
}

/** Heuristically detect the API calls the app makes (the consumer side). */
export async function detectApiCalls(path: string): Promise<ApiCall[]> {
  return invoke<ApiCall[]>("detect_api_calls", { path });
}

/** Recursively find files/folders under root whose name matches the query. */
export async function searchFiles(root: string, query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_files", { root, query });
}

/** Check whether (and how) a project can be previewed locally. */
export async function previewStatus(projectPath: string): Promise<PreviewStatus> {
  return invoke<PreviewStatus>("preview_status", { projectPath });
}

/** Install a Node project's dependencies (`npm install`). */
export async function installDeps(projectPath: string): Promise<void> {
  return invoke("install_deps", { projectPath });
}

/**
 * Install a single preview requirement (preview-only): "node" / "dotnet" via the
 * package manager, or "maui" via the .NET workload installer. Rejects with a
 * `friendly||KINETEK_DEV||raw` string on failure (see splitPreviewError).
 */
export async function installPreviewRequirement(key: string): Promise<void> {
  return invoke("install_preview_requirement", { key });
}

/** Separator the backend uses to pack a friendly message + raw dev detail. */
export const PREVIEW_DEV_SEP = "||KINETEK_DEV||";

/** Split a preview error into its friendly message and raw developer detail. */
export function splitPreviewError(e: unknown): { friendly: string; dev: string } {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const i = s.indexOf(PREVIEW_DEV_SEP);
  return i === -1
    ? { friendly: s, dev: "" }
    : { friendly: s.slice(0, i), dev: s.slice(i + PREVIEW_DEV_SEP.length) };
}

/** Start a preview (dev server or static site); resolves with its URL + id. */
export async function startPreview(projectPath: string): Promise<PreviewInfo> {
  return invoke<PreviewInfo>("start_preview", { projectPath });
}

/** Stop a running preview (kills its dev server). */
export async function stopPreview(id: string): Promise<void> {
  return invoke("stop_preview", { id });
}

/**
 * Open the running preview in a dedicated Kinetek window. Closing that window
 * stops the underlying dev server.
 */
export async function openPreviewWindow(
  project: Project,
  info: PreviewInfo
): Promise<void> {
  const win = new WebviewWindow(`preview-${info.id}`, {
    url: info.url,
    title: `Preview · ${project.name}`,
    width: 1100,
    height: 800,
    resizable: true,
  });

  return new Promise((resolve, reject) => {
    win.once("tauri://created", () => resolve());
    win.once("tauri://error", (e) =>
      reject(
        new Error(
          typeof e?.payload === "string"
            ? e.payload
            : "Could not open the preview window."
        )
      )
    );
    // Stop the dev server when the preview window is closed.
    win.once("tauri://destroyed", () => {
      void stopPreview(info.id);
    });
  });
}

/** Reveal a path in Finder (macOS) / Explorer (Windows) / file manager. */
export async function openInFileManager(path: string): Promise<void> {
  return invoke("open_in_file_manager", { path });
}

/** Native folder picker; returns the chosen absolute path or null. */
export async function pickDirectory(
  title = "Choose where to create your project"
): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selected === "string" ? selected : null;
}
