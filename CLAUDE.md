# Kinetek — agent briefing

> You are picking up an existing project. Read this file first instead of scanning
> every source file. It's written by you, for you (a future Claude session). It
> tells you what Kinetek is, how it's built, where things live, the conventions
> you must follow, and the traps that have already bitten us. Trust it, but if it
> ever contradicts the code, the code wins — fix this file when that happens.

## What Kinetek is

A local-first **macOS/Windows desktop app**: a highly visual, human-readable
"control center" and translator between the user's **file system, GitHub, and
VS Code**. Two audiences at once:

- A **non-technical person** should be able to glance at it and understand what
  each project is and its status (plain-English summaries, clear status badges).
- The **developer** (the user) gets powerful bootstrapping: scaffold projects,
  preview them, browse code, manage git, and pull/push to GitHub — without
  living in the terminal.

It's intended as a long-term "big project," not a throwaway. Bias toward clean
architecture and finishing features end-to-end (UI + backend + verified build).

## Stack

**Tauri v2 · React 18 · TypeScript · Tailwind CSS v3 · Vite.**

- Frontend: `src/` (React/TS). Entry `src/main.tsx` → `src/App.tsx`.
- Backend: `src-tauri/src/lib.rs` (~2300 lines, ALL the Rust commands).
  `main.rs` is a thin shim calling `kinetek_lib::run()`.
- Styling: Tailwind, dark theme. Tokens in `tailwind.config.js` (e.g.
  `surface-base/raised/card/border/hover`, `accent`/`accent-soft`/`accent-glow`,
  custom animations `fade-in`, `scale-in`, `slide-in-right`, `shimmer`,
  `pulse-ring`). **Only use tokens that exist there** — inventing a class like
  `surface-borderStrong` silently no-ops.

## How to build & verify (do this after every change)

```bash
npm run build          # tsc + vite build  → catches all TS/React errors
cd src-tauri && cargo check   # → catches all Rust errors
```

Both must be clean before you call something done. For a shippable bundle:
`npm run tauri build` (outputs `Kinetek.app` + a `.dmg` under
`src-tauri/target/release/bundle/`). Dev: `npm run tauri:dev`.

## The golden conventions (do not break these)

1. **The frontend NEVER calls `invoke` directly.** Every backend call goes
   through a typed wrapper in `src/lib/tauri.ts`. Add new commands there.
2. **Rust structs serialize `camelCase`** (`#[serde(rename_all = "camelCase")]`)
   to match the TS interfaces in `src/types.ts`. When you change a struct, change
   `types.ts` in lockstep — they mirror each other by hand.
3. **Register every new `#[tauri::command]`** in the `tauri::generate_handler![…]`
   list at the bottom of `lib.rs` (currently ~35 commands), or it won't exist at
   runtime.
4. **Long-running Rust work runs in `tauri::async_runtime::spawn_blocking`** and
   returns `Result<T, String>` with *human-readable* error strings (they get
   shown to the user as toasts).
5. **Cross-platform process exec goes through `make_command()`** (wraps `cmd /C`
   on Windows). Don't spawn raw `Command` for user-facing tools.
6. **Permissions** live in `src-tauri/capabilities/default.json`. Prefer writing
   a focused Rust command over widening shell/fs/http scopes. The `http` allow
   list is scoped to specific hosts (the 5 AI providers + `api.github.com`) — add
   a host there if you call a new API via plugin-http.
7. **Secrets (API keys, GitHub token) live in the OS keychain**, never on disk in
   plaintext, never embedded in the binary. Via `set/get/delete_secret`
   (`keyring` crate). AI keys are keyed `apikey:<providerId>` (`secretKeyFor` in
   `lib/ai.ts`); the GitHub token is `GITHUB_TOKEN_KEY = "github-token"`.
8. **Match the surrounding code's style.** Components are functional, hooks-based,
   Tailwind utility classes inline, small inline SVG icons from
   `components/icons.tsx` (no icon dependency — add new icons there).
9. **Verify before deleting/overwriting.** This is a real project with real user
   data; never destructively act on a folder you didn't create without confirming.

## Repo map (what each file is for)

### Frontend `src/`
- `App.tsx` — the orchestrator. Holds all top-level state: `projects`,
  `folders`, `assignments`, `settings` (persisted as one `Organization`), the
  current `view` (`"dashboard" | "explorer" | "github"`), the inspected project
  (right panel), and `expandedId` (full-page project view). Loads the workspace
  on mount, saves on any change (guarded by `orgLoaded`). All the handlers
  (scan, create, delete, preview, explain, etc.) live here and are passed down.
- `types.ts` — shared domain types; **mirror of the Rust structs**.
- `index.css` — Tailwind layers + a few globals.

`src/lib/` (the bridge + logic, no JSX):
- `tauri.ts` — typed wrappers around every backend command. **Start here** when
  you need a backend capability.
- `github.ts` — GitHub REST client via plugin-http (`getGithubUser`,
  `listGithubRepos`, `listAllGithubRepos`, `createGithubRepo`). Friendly 401/403
  messages that steer the user to a **classic token with `repo` scope**.
- `ai.ts` — `AI_PROVIDERS` (BYOK: Gemini/Groq/OpenRouter free, Claude/OpenAI
  paid) + `secretKeyFor`.
- `generate.ts` — AI generation/explanation; all 5 providers implemented via
  plugin-http (Gemini generateContent, OpenAI-compatible chat/completions,
  Anthropic Messages). Returns structured JSON `{files:[{path,contents}]}`.
- `categories.ts` — "Build by goal" categories/purposes + `composePrompt`.
- `templates.ts` — framework templates; **ids must match `scaffold_for()` match
  arms in lib.rs**.
- `logStore.ts` — `useSyncExternalStore`-backed in-app log (real-time console).
- `sampleData.ts` — placeholder cards shown only in a plain browser (not Tauri).

`src/components/` (presentational + feature panels):
- `TitleBar.tsx` — draggable custom title bar + settings gear.
- `Sidebar.tsx` — primary nav (`NAV_ITEMS`: Dashboard/Explorer/GitHub) +
  virtual folders (create/rename/delete). **Add a new top-level page** by adding
  to `NAV_ITEMS`, extending `ViewMode`, and adding a branch in App's `view`
  switch.
- `Dashboard.tsx` / `ProjectCard.tsx` — the project grid + cards (status chip,
  git status chip, folder assign, edit/delete/preview/explain, click to inspect).
- `ProjectWizard.tsx` — New Project flow (~1500 lines; all step subcomponents in
  one file — **split into `components/wizard/` if it grows**). Two paths:
  framework-first and goal-first; live build terminal; AI starter step.
- `ProjectPanel.tsx` — right-side **inline** inspector (~1/3 width, not an
  overlay) shown on the dashboard. Files | Git tabs. Has an **expand** button →
  full-page view.
- `ProjectPage.tsx` — **full-page** project view (replaces the whole content
  area; back button returns). Tabs: Overview / Files / History / Source control.
- `CommitGraph.tsx` — **Fork-style commit graph** (SVG lanes/merges) for the
  History tab. See "Commit graph" below.
- `FileBrowser.tsx` / `FileTree.tsx` / `FileViewer.tsx` — shared read-only file
  browsing. `FileBrowser` = debounced search box wrapping the lazy recursive
  `FileTree` (empty query → tree, query → flat results). `FileViewer` =
  syntax-highlighted source viewer (highlight.js; HTML maps to "xml" so it shows
  as escaped SOURCE, never rendered — the user was explicit: **no webview**).
  Used by both Explorer and the project views.
- `Explorer.tsx` — read-only disk file finder (the "Kinetek as a visual file
  tree" view).
- `GithubPage.tsx` — the GitHub page: browse **every** accessible repo + **save
  locally** (clone). See "GitHub" below.
- `GitPanel.tsx` — per-project source control + GitHub account connect
  (commit/push, link/create repo).
- `SettingsDialog.tsx` / `EditProjectDialog.tsx` / `ConfirmDialog.tsx` — dialogs.
- `Field.tsx` — shared labelled form field (don't re-duplicate it).
- `StatusBadge.tsx` / `FrameworkTag.tsx` / `LogConsole.tsx` / `icons.tsx` — small
  shared UI. **All icons live in `icons.tsx`** as inline SVGs.

### Backend `src-tauri/src/lib.rs`
One file, grouped by feature. Command catalog (all registered in
`generate_handler!`):
- **Projects:** `create_project` (emits `project-output` events per line for the
  live terminal), `scan_projects`, `write_generated_files` (path-traversal
  guarded), `read_project_context`.
- **Tooling:** `check_prerequisites`, `install_tool` (brew/winget).
- **Delete:** `delete_project` (Trash via `NSFileManager`),
  `delete_project_permanently` (fallback for iCloud-evicted files).
- **Preview:** `preview_status`, `install_deps`, `start_preview` (spawns dev
  server, parses the printed `localhost:PORT`), `stop_preview` (`kill_tree`,
  process-group kill on Unix).
- **Persistence/secrets:** `load_organization`/`save_organization` (JSON in
  app **config dir**, keyed by bundle id), `set/get/delete_secret` (keychain).
- **Git (local):** `git_status`, `git_changes`, `git_remote`, `git_commit`,
  `git_push` (token-auth HTTPS, **token scrubbed from errors**), `git_init`,
  `git_set_remote`, `git_log` (commit graph), `git_clone` (token scrubbed from
  saved remote + errors).
- **Files:** `read_dir`, `read_file_text` (UTF-8, flags binary/tooLarge/
  truncated), `search_files`, `home_dir`.
- **Open externally:** `open_in_editor` (vscode/cursor/zed/finder),
  `open_in_vscode`, `open_in_file_manager`, `log_error`.

## Feature notes worth knowing

- **Navigation:** Sidebar nav is a scalable vertical list. The right inspector
  only renders on the dashboard view. The full-page project view (`expandedId`)
  takes over the entire content region (sidebar included) until dismissed.

- **GitHub page:** `listAllGithubRepos` paginates (per_page=100, ≤10 pages) with
  `affiliation=owner,collaborator,organization_member`, de-duped, newest-pushed
  first. "Save locally" → `git_clone(url, dest, token)` → adds a project card
  (summary seeded from the repo description). Repos already on disk show "Saved"
  (matched by folder basename via `localNames` from App).

- **Commit graph (`CommitGraph.tsx`):** backend `git_log` runs
  `git log --all --date-order` with a `%x1f`-field / `%x1e`-record pretty format
  (safe against newlines in messages). The component runs the **classic
  lane-reservation layout**: a commit takes the lane that was waiting for it (or
  a new one); its first parent keeps the lane (straight line), extra parents open
  new lanes (merges); duplicate reservations of the same parent collapse
  leftmost-wins. Lanes/merges are an absolutely-positioned **SVG overlay** behind
  the text rows (bezier across one row, then straight down; coloured by
  destination lane from an 8-colour palette). Commits arrive newest-first so
  lanes read top→down.

- **Git auth model:** plain `git push` works if the user's existing creds do.
  For GitHub over HTTPS we build `https://<token>@github.com/owner/repo.git` from
  the keychain token. The token is a **classic PAT with `repo` scope** (the help
  links point to `tokens/new?scopes=repo`). It is **always scrubbed** from any
  error text and never persisted into `.git/config` (clone resets origin to the
  clean URL afterward).

- **AI:** **BYOK only** — never embed Kinetek's own key in the binary. Keys are
  in-memory during generation but the saved ones come from the keychain.

## Environment gotchas (these have actually burned us)

- The project lives under `~/Desktop`, which has **iCloud "Desktop & Documents"
  sync** on. Two consequences:
  1. The `tauri dev` file-watcher rebuild loop — mitigated by
     `src-tauri/.taurignore` (ignores icons/, gen/, target/).
  2. **Trash failures**: Finder refuses to trash iCloud-evicted ("needs to be
     downloaded", error -8013) items. That's why delete uses `NSFileManager` and
     offers a permanent-delete fallback. The clean long-term fix (move the repo
     off the synced Desktop) the user keeps declining — don't assume it's done.
- `git` and `node`/`npm` are expected on PATH; a Finder-launched app may have a
  reduced PATH, hence helpers like `resolve_brew()` that probe common locations.
- The bundle identifier is `com.kinetek.app`, which Tauri warns about (ends in
  `.app`). Cosmetic; flagged for a future rename to e.g. `com.kinetek.desktop`.
- Builds are **unsigned** — first launch hits Gatekeeper (right-click → Open).

## User context

- The user has **two GitHub accounts**: **Odyssi-Sec** (primary, where most
  repos live) and **Odious-Sec** (secondary). The keychain holds one token at a
  time; whichever account it belongs to is the one the GitHub page/GitPanel act
  as. Multi-account support is a roadmap idea, not built.
- The user is the developer and wants both power and a non-technical-friendly UI.
  Keep error messages plain-English and actionable.

## Roadmap / open ideas (not yet built)

- Per-commit changed-files (`git show --stat`) in the History detail pane.
- Branch checkout/switch from the graph; pull/fetch in GitPanel.
- "Clone all" bulk action on the GitHub page.
- Multi-account GitHub support.
- Optional disk-managed folders (real `mkdir`/`mv`, permission-gated) — the
  destructive half was deliberately deferred; folders are virtual for now.
- Splitting `ProjectWizard.tsx` into `components/wizard/`.

---
*Keep this file current. When you add a feature or learn a new gotcha, update the
relevant section so the next session doesn't have to rediscover it.*
