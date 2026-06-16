# Kinetek — agent briefing

> You are picking up an existing project. Read this file first instead of scanning
> every source file. It's written by you, for you (a future Claude session). It
> tells you what Kinetek is, how it's built, where things live, the conventions
> you must follow, and the traps that have already bitten us. Trust it, but if it
> ever contradicts the code, the code wins — fix this file when that happens.
>
> **Need more than the map?** This file is the overview. For exact backend
> command signatures, struct⇄type tables, step-by-step flows, the commit-graph
> algorithm, GitHub/AI internals, and a conventions checklist, open
> **[`PROJECT.md`](./PROJECT.md)** — the detailed companion reference. Read it
> when you're about to work on a subsystem; you don't need it just to orient.

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
  current `view` (`"home" | "projects" | "explorer" | "github" | "terminal"`,
  default `"home"`), and `expandedId` — **selecting a project anywhere opens the
  full-page `ProjectPage`** (there is no side inspector anymore). Loads the
  workspace on mount, saves on any change (guarded by `orgLoaded`). All the handlers
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
- `templates.ts` — framework templates; each has `kinds`/`platforms`/`scaffold`
  ("cli"|"files"|"placeholder"). **ids must match `scaffold_for()` match arms in
  lib.rs**. Web/Mobile/Desktop/API/Tool frameworks all live here.
- `catalog.ts` — the New Project **funnel** data: `APP_CATEGORIES` (Web/Mobile/
  Desktop + their platforms), `frameworksFor(kind, platform)`, `API_FRAMEWORKS`,
  `DATABASES`. Add a framework = a `templates.ts` entry (+ `scaffold_for` arm);
  the funnel picks it up automatically.
- `logStore.ts` — `useSyncExternalStore`-backed in-app log (real-time console).
- `sampleData.ts` — placeholder cards shown only in a plain browser (not Tauri).

`src/components/` (presentational + feature panels):
- `TitleBar.tsx` — draggable custom title bar + settings gear.
- `Sidebar.tsx` — primary nav (`NAV_ITEMS`: Dashboard(home)/Projects/Explorer/
  GitHub/Terminal) + virtual folders (shown only on the Projects view). **Add a
  new top-level page** by adding to `NAV_ITEMS`, extending `ViewMode`, and adding
  a branch in App's `view` switch.
- `DashboardHome.tsx` — the **landing** (`view==="home"`): a registry-driven
  **widget board**. Each entry pairs a column span with a render fn on a 6-col
  grid; **grow the dashboard = add one entry** here + a widget under
  `components/widgets/`. Pulls a git-status aggregate from
  `hooks/useProjectStatuses.ts` and shares it across widgets.
- `components/widgets/` — `Widget.tsx` (shared card chrome), `ProjectRow.tsx`
  (shared clickable row), `QuickActionsWidget`, `StatsWidget`,
  `RecentProjectsWidget`, `NeedsAttentionWidget`, `ActivityWidget` (reads the
  live `logStore`). Widget project clicks open the full-page `ProjectPage`.
- `Dashboard.tsx` / `ProjectCard.tsx` — the **Projects** grid + cards
  (`view==="projects"`): status chip, git status chip, folder assign,
  edit/delete/preview/explain. **Clicking a card opens the full-page
  `ProjectPage`** (no more side inspector). Folders live on this view.
- `ProjectWizard.tsx` — New Project flow **orchestrator**: the phase state
  machine + shared build/preflight logic. Each phase's UI is a focused component
  in **`components/wizard/`** (`ModeStep`, `CategoryStep`, `PurposeStep`,
  **`AppTypeStep`**, **`PlatformStep`**, `TemplateStep`, **`StackStep`**,
  `DetailsStep`, `PreflightStep`, `RunningStep`, `GenerateStep`, `DoneStep`,
  `ErrorStep`). Framework path is a **funnel**: appType → (platform?) → framework
  → **stack** (optional API + DB) → details → preflight → running. Goal path:
  category → purpose → stack → details → … Preflight checks the **union** of
  app+API prereqs. Live build terminal. **Add a step** = new file in
  `components/wizard/` + wire it into the orchestrator's body/footer + `Phase`.
- `ProjectPage.tsx` — **full-page** project view (replaces the whole content
  area), reached by selecting a project. A **breadcrumb** (`Projects › <name>`)
  navigates back. Tabs: Overview / Files / (API, when an `api/` part exists) /
  History / Source control (Overview is full-width; header actions pinned right).
  The **Files**
  tab is an **IDE-style editor**: an **App / API / Database** part switcher (for
  assembled projects) re-roots the tree to `app/`/`api/`/`database/`, and clicking
  a file opens it in the **Monaco `CodeEditor`** — edit + save with live syntax
  diagnostics. Header has a split **Proceed to IDE** (▾ menu: whole project, the
  active part folder, or **"Open this file"** = opens the part folder as the
  workspace *with the file focused* via `open_in_editor(folder, editor, file)`),
  plus a **Preview** button (previews the `app/` part for assembled projects, else
  the root, through `PreviewDialog`).
  The Source-control tab is a **two-pane git workspace**: `GitPanel` on the left,
  a `DiffViewer` of the selected change filling the rest (uses the full width).
  The History tab is `RefsSidebar` (branches/remotes/tags/stashes) + `CommitGraph`.
  The right side is a **persistent, resizable dock** (toggled from the header,
  drag handle to resize) that stays put while you switch the left tabs — an
  IDE-style split. The dock has a **Claude Code | Terminal** segmented toggle:
  Claude Code (`ClaudePanel`) or a PTY `TerminalView` rooted at the project
  (lazy-mounted on first open; both kept mounted so switching doesn't kill a
  run/shell).
- `CommitGraph.tsx` — **Fork-style commit graph** (SVG lanes/merges) for the
  History tab. See "Commit graph" below.
- `Markdown.tsx` — tiny dependency-free Markdown renderer (headings, lists,
  blockquotes, rules, **bold**, links, inline + fenced code highlighted via
  highlight.js). Renders real React nodes (safe). Used to make Claude Code output
  look clean (not raw terminal text).
- `FileBrowser.tsx` / `FileTree.tsx` — shared file browsing. `FileBrowser` =
  debounced search box wrapping the lazy recursive `FileTree` (empty query →
  tree, query → flat results). Used by Explorer and `ProjectPage`'s Files tab.
- `CodeEditor.tsx` — **in-app code editor** (Monaco), **lazy-loaded** (its own
  ~3.3 MB chunk; only loads when a file is opened). Edit + **Save** (⌘S, dirty
  dot) real files via `write_file_text`. **Live diagnostics**: Monaco's built-in
  language services for JS/TS/JSON/CSS/HTML; for Python/Go an **on-save backend
  check** (`check_syntax`) is surfaced as Monaco markers (same squiggles). Monaco
  workers + bundled loader + the `kinetek` dark theme are set up in
  `src/lib/monaco.ts` (kept in the lazy chunk; needs `worker-src`/`font-src` in
  the Tauri CSP). Replaced the old read-only `FileViewer` (deleted).
- `Explorer.tsx` — read-only disk file finder (the "Kinetek as a visual file
  tree" view).
- `GithubPage.tsx` — the GitHub page: browse **every** accessible repo + **save
  locally** (clone). See "GitHub" below.
- `GitPanel.tsx` — per-project source control + GitHub account connect
  (commit/push, link/create repo, **public/private toggle**, **delete the GitHub
  repo while keeping local files**). Changed files are clickable when given
  `onSelectChange` (drives the diff pane in `ProjectPage`).
- `DiffViewer.tsx` — coloured unified diff of local changes (`git_diff`); used in
  `ProjectPage`'s Source-control tab to show what changed vs the last commit.
- `TerminalView.tsx` — a real interactive terminal (xterm.js + the PTY backend),
  the **Terminal** sidebar page. **Lazy-loaded** (`React.lazy` in `App.tsx`) so
  xterm (~294 kB) is a separate chunk that only loads when opened. Streams bytes
  both ways; fits/resizes via `ResizeObserver` + `FitAddon`.
- `ApiPanel.tsx` — the **API explorer** (a `ProjectPage` tab shown when the
  project has an `api/` part): lists detected routes (method · path · file:line)
  from `detect_endpoints`, filterable, click a row → opens the file in the editor.
  Heuristic, framework-agnostic. First step toward a request tester.
- `ClaudePanel.tsx` — the **Claude Code** right-dock panel in `ProjectPage`
  (toggled from the header, resizable): delegates a
  prompt to the installed `claude` CLI in the project dir, injecting a Kinetek
  state snapshot (project + live git status/changes) so the agent knows what the
  user is looking at. Streams output live; Plan vs Auto-edit mode. Shows an
  install hint if `claude` isn't found (`check_tool`). Output is rendered with
  `Markdown.tsx` (highlighted code, headings, lists) — not raw terminal text. Has
  a **"Generate context docs"** action (`DOCS_PROMPT`, forces `acceptEdits`):
  Claude Code writes `CLAUDE.md` + `README.md` into `app/`, `api/`, and the root
  (skipping absent parts) so there's context before opening the IDE.
- `RefsSidebar.tsx` — our-style (NOT Fork's) refs panel: collapsible
  Branches/Remotes/Tags/Stashes with create-branch, checkout, delete-branch, and
  stash save/apply/pop/drop. Lives in `ProjectPage`'s History tab beside the
  graph. `CommitGraph` has a **"Create branch here"** action in its detail pane.
  Both share a `gitRefreshKey` so a mutation in one refreshes the other.
- `SettingsDialog.tsx` / `EditProjectDialog.tsx` / `ConfirmDialog.tsx` — dialogs.
- `PreviewDialog.tsx` — the **single entry point for Preview**: shows the
  detected kind, lists requirements with preview-only installs, runs it, and on
  failure shows a friendly reason + raw dev output behind a toggle. App opens it
  via `previewProject` state.
- `Field.tsx` — shared labelled form field (don't re-duplicate it).
- `StatusBadge.tsx` / `FrameworkTag.tsx` / `LogConsole.tsx` / `icons.tsx` — small
  shared UI. **All icons live in `icons.tsx`** as inline SVGs.

### Backend `src-tauri/src/lib.rs`
One file, grouped by feature. Command catalog (all registered in
`generate_handler!`):
- **Projects:** `create_project(appTemplateId, apiTemplateId?, databaseEngine?, …)`
  — assembles an **app + optional API + optional database** into one project. Flat
  (`parent/<name>`) when app-only; **monorepo** (`<name>/app`, `/api`, `/database`
  + root README) when an API or DB is added. `apply_scaffold` runs each part into
  its subfolder; `database_files(engine)` writes a placeholder (schema/.env/
  docker-compose). Emits `project-output` per line. Returns `ProjectInfo.stack`.
- **Projects (cont.):** `scan_projects`, `write_generated_files` (path-traversal
  guarded), `read_project_context`.
- **Tooling:** `check_prerequisites`, `check_tool(key)` (single tool, e.g.
  "claude"), `install_tool` (brew/winget).
- **Interactive terminal (PTY):** `terminal_open(id, cwd, cols, rows)` spawns the
  user's real login shell in a PTY (`portable-pty`), streaming `terminal-output`
  events (`{id, bytes}`) and `terminal-exit`; `terminal_write(id, data)`,
  `terminal_resize(id, cols, rows)`, `terminal_close(id)`. Sessions tracked in
  `TerminalState`. It's a real shell (prompts/colors/TUIs work) — e.g. to install
  the Claude Code CLI from inside Kinetek.
- **Claude Code delegation:** `run_claude_agent(runId, projectPath, prompt, mode)`
  — runs the user's `claude` CLI in the project dir (`-p --output-format
  stream-json --verbose --permission-mode`), streams `claude-output` events
  (NDJSON parsed on the frontend so activity shows live, not buffered), ends with
  `claude-done`; `stop_claude(runId)`
  signals the process group. Uses the user's own Claude Code auth — no Kinetek
  secret. `mode`: "plan" (read-only) | "acceptEdits" (can edit files).
- **Delete:** `delete_project` (Trash via `NSFileManager`),
  `delete_project_permanently` (fallback for iCloud-evicted files).
- **Preview:** `preview_status` (returns a `requirements[]` list + `ready`/`how`
  for web/static/dotnet/maui — see "Preview" note below), `install_deps`,
  `install_preview_requirement` (node/dotnet/maui workload, preview-only),
  `start_preview` (web→dev server + `localhost:PORT`; static→file://; .NET→build
  then launch), `stop_preview` (`kill_tree`, process-group kill on Unix).
- **Persistence/secrets:** `load_organization`/`save_organization` (JSON in
  app **config dir**, keyed by bundle id), `set/get/delete_secret` (keychain).
- **Git (local):** `git_status`, `git_changes`, `git_remote`, `git_commit`,
  `git_push` (token-auth HTTPS, **token scrubbed from errors**), `git_init`,
  `git_set_remote`, `git_log` (commit graph), `git_clone` (token scrubbed from
  saved remote + errors), `git_diff(path, file?)` (local changes vs HEAD;
  untracked files synthesized as all-added), `git_remove_remote` (drop origin
  after deleting the GitHub repo — keeps files), `git_refs` (branches/remotes/
  tags + current), `git_create_branch(name, at?, checkout)`, `git_checkout`,
  `git_delete_branch(name, force)`, and stashes: `git_stashes`, `git_stash_save`,
  `git_stash_apply(index, pop)`, `git_stash_drop`.
- **Files:** `read_dir`, `read_file_text` (UTF-8, flags binary/tooLarge/
  truncated), `write_file_text` (in-app editor save), `check_syntax(path)`
  (on-save diagnostics — Python via `py_compile`, Go via `gofmt -e`; `[]` for
  Monaco-handled or unsupported langs), `detect_endpoints(path)` (heuristic
  route scan via `regex` for the API explorer — Express/Nest/FastAPI/Flask/
  ASP.NET/Go → `Endpoint{method,route,file,line}`), `search_files`, `home_dir`.
- **Open externally:** `open_in_editor(path, editor, file?)` (vscode/cursor/zed/
  finder; `file` opens `path` as the workspace AND focuses that file —
  `code <folder> <file>`), `open_in_vscode`, `open_in_file_manager`, `log_error`.

## Feature notes worth knowing

- **Navigation:** Sidebar nav is a scalable vertical list (`home` is the default
  landing widget board; `projects` is the grid). Folders render on the `projects`
  view. **Selecting a project** (a card, or any dashboard widget row) sets
  `expandedId` → the full-page `ProjectPage` takes over the entire content region
  (sidebar included); its breadcrumb returns to `projects`. There is no side
  inspector (it was removed in favor of this full-page navigation).

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

- **Preview:** `preview_status` recognizes web (npm dev/start/serve), static
  (`index.html`), and **.NET** (`.csproj`/`.sln`, with MAUI detected from the
  csproj) and returns a `requirements[]` (each `{key,name,satisfied,detail,
  installable,installLabel,url}`) + `ready` + `how`. `PreviewDialog` lists
  unmet requirements with **preview-only installs** (`install_preview_requirement`
  → node/dotnet via package manager, `maui` via `dotnet workload install maui`).
  Running: web/static open a `WebviewWindow`; **.NET builds then launches the app
  in its own window** (a clean build is the "it works" signal — there's no
  webview for native). On failure, errors are packed as
  `friendly||KINETEK_DEV||raw` (const `PREVIEW_DEV_SEP`; `splitPreviewError` in
  `lib/tauri.ts`) so the dialog shows plain English + raw output behind a toggle;
  `classify_dotnet_failure` maps common build errors to friendly reasons
  ("needs the MAUI workload", "older project that needs updating", etc.).

- **AI:** **BYOK only** — never embed Kinetek's own key in the binary. Keys are
  in-memory during generation but the saved ones come from the keychain.

- **Claude Code (agentic coding):** the "Claude Code" tab delegates to the
  installed `claude` CLI rather than reimplementing an agent. It runs in the
  project dir (so the agent has project context), and Kinetek injects a
  `<kinetek-context>` snapshot (selected project + live git status/changes) into
  the prompt so it also knows *what the user is looking at*. Runs headless
  (`claude -p … --permission-mode`), streaming output to the UI. **Auth is the
  user's own Claude Code sign-in — Kinetek stores no key for this** (distinct
  from the BYOK Anthropic API used by generate/explain). Permission modes: Plan
  (read-only, default) vs Auto-edit (`acceptEdits`). The deeper "agent can query
  Kinetek's live state / call its actions" path would be an **MCP server** — not
  built. `claude` runs via a Rust `Command` (like git/dotnet), so no shell-plugin
  capability is needed.

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

---
*Keep this file current. When you add a feature or learn a new gotcha, update the
relevant section so the next session doesn't have to rediscover it.*
