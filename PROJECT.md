# Kinetek — detailed reference

> Companion to `CLAUDE.md`. That file is the lean map you read at session start;
> this file is the deep reference you open when you actually need specifics about
> a subsystem. Don't read it top-to-bottom — jump to the section you need.
> Accuracy over brevity here: exact signatures, data shapes, and flows. If it
> drifts from the code, fix it.

## Contents
1. Backend command reference (signatures + behaviour)
2. Data model (Rust struct ⇄ TS interface pairs)
3. Persistence & secrets
4. Frontend state & data flow
5. Key flows, step by step
6. The commit-graph algorithm
7. GitHub integration & auth
8. AI generation (BYOK)
9. Templates & scaffolding
10. Capabilities / permissions
11. Build, run, release
12. Conventions checklist (quick)

---

## 1. Backend command reference

All in `src-tauri/src/lib.rs`, all `#[tauri::command]`, all registered in
`generate_handler![…]` at the bottom of the file. Each returns
`Result<T, String>`; the `Err(String)` is a human-readable message shown to the
user. Heavy ones wrap their body in `spawn_blocking`. Arg names below are what
the TS side passes (camelCase) — Tauri maps them to the Rust snake_case params.

### Projects
- `create_project(parentDir, projectName, appTemplateId, apiTemplateId?, databaseEngine?, summary, status, frameworks) -> ProjectInfo`
  Takes the `AppHandle`. Assembles **app + optional API + optional database**:
  - **Flat** (no API, no DB): scaffolds the app directly at `parent/<name>`
    (the original single-template behavior).
  - **Monorepo** (API and/or DB chosen): creates `<name>/`, then `app/`, `api/`,
    `database/` inside it + a root `README.md`.
  - `apply_scaffold(app, scaffold, run_dir, folder)` runs one part into a
    subfolder (CLI tools create `run_dir/folder`; file generators write into it);
    `write_files` is the shared file-writer; `database_files(engine)` emits the DB
    placeholder (README + schema.sql/.md + .env.example + docker-compose for
    server engines). **Emits `project-output` per line** for the live terminal.
    Returns `ProjectInfo.stack = {app, api?, database?}`.
- `scan_projects(dir) -> Vec<ProjectInfo>` — one level deep; a child dir counts
  as a project iff `detect_frameworks` finds something; skips dotdirs and
  `node_modules`. Sorted A→Z.
- `write_generated_files(projectPath, files: GeneratedFile[]) -> usize` —
  **path-traversal guarded**: rejects absolute paths and `..`, canonicalizes the
  parent against the project root. Returns count written.
- `read_project_context(projectPath) -> ProjectContext` — README + package.json
  (truncated) for AI summarization.

### Tooling / prerequisites
- `check_prerequisites(templateId) -> Vec<Prerequisite>` — per `template_prereqs`.
- `check_tool(key) -> Prerequisite` — single tool from the catalog (e.g.
  "claude"); used to detect Claude Code.
- `install_tool(toolKey) -> ()` — brew (macOS) / winget (Windows); manual-only
  tools (Android Studio, Xcode, Claude Code) return an error pointing to a URL.

### Claude Code delegation
- `run_claude_agent(app, state, runId, projectPath, prompt, mode) -> ()` — runs
  the user's `claude` CLI headless (`claude -p <prompt> --output-format
  stream-json --verbose --permission-mode <mode>`) in `projectPath`. stream-json
  emits NDJSON events as they happen (init/assistant/tool_use/result) so the UI
  shows activity immediately — default text mode buffers until the whole turn
  ends (felt "stuck/slow to connect"). `ClaudePanel.parseStream` turns the events
  into answer text + an activity strip (`$ cmd`, `✎ file`, `↳ read …`). `spawn_blocking` owns the run; the pid is tracked in
  `ClaudeState(Arc<Mutex<HashMap<runId,pid>>>)`. stdout/stderr stream line-by-line
  as `claude-output` events `{runId, line, stream}`; completion emits
  `claude-done {runId, ok}`. `mode` ∈ plan | acceptEdits | default |
  bypassPermissions (frontend offers plan/acceptEdits). Auth = the user's own
  Claude Code sign-in; **Kinetek stores no key**. `ClaudePanel.tsx` injects a
  `<kinetek-context>` snapshot (project + `gitStatus`/`gitChanges`) before the
  user's prompt so the agent knows what's on screen, not just the files on disk.
  In `ProjectPage` it's a **persistent resizable right dock** (header toggle +
  drag handle, width clamped 320..body-360), so it stays open while you switch
  the left tabs (Files/diff/source-control) — an IDE-style split, not a tab. The
  dock has a **Claude Code | Terminal** segmented toggle (`DockView`): Claude
  (`ClaudePanel`) or a PTY `TerminalView` rooted at the project (lazy-mounted on
  first Terminal open via `termStarted`; both panels stay mounted, toggled with
  `hidden`, so switching doesn't kill an agent run or shell). Claude output is
  rendered by `Markdown.tsx` (dependency-free: headings/lists/blockquote/bold/
  links/inline + fenced code highlighted via highlight.js → real React nodes,
  safe), so it reads like a clean chat response rather than raw terminal text.
- `stop_claude(state, runId) -> ()` — signals the process group (Unix).
- Roadmap: an MCP server exposing Kinetek's state/actions for live two-way
  context (the agent could query Kinetek and trigger its actions).

### Interactive terminal (PTY)
- Backed by **`portable-pty`** (Cargo) + **xterm.js** (`@xterm/xterm` +
  `@xterm/addon-fit`). A real login shell, so prompts/colors/TUIs and interactive
  installs (e.g. the Claude Code CLI) work.
- `terminal_open(app, state, id, cwd, cols, rows) -> ()` — opens a PTY, spawns
  `$SHELL -l` (or `%COMSPEC%`) with `TERM=xterm-256color` at `cwd`, and pumps
  output as `terminal-output {id, bytes: Vec<u8>}` events; emits `terminal-exit`
  on shell exit. Session stored in `TerminalState(Mutex<HashMap<id, TermSession>>)`
  (`{master, writer, child}`).
- `terminal_write(id, data)`, `terminal_resize(id, cols, rows)`,
  `terminal_close(id)` (kills the shell).
- `TerminalView.tsx` (xterm) is **lazy-loaded** in `App.tsx` (`React.lazy` +
  `Suspense`) so xterm is a separate ~294 kB chunk, not in the startup bundle. It
  decodes `bytes` → `Uint8Array` → `term.write`, sends `term.onData` →
  `terminal_write`, and fits/resizes via `ResizeObserver` + `FitAddon`. cwd =
  `settings.defaultDir` or `homeDir()`.

### Delete
- `delete_project(path) -> ()` — move to Trash via `NSFileManager` (macOS) /
  platform trash. `guard_deletable` refuses shallow/system/home paths.
- `delete_project_permanently(path) -> ()` — `fs::remove_dir_all`; the fallback
  for iCloud-evicted placeholders Finder won't trash.

### Preview (run locally)
- `preview_status(projectPath) -> PreviewStatus` — recognizes web (a
  `dev`/`start`/`serve` npm script → kind `"web"`, runner `"node"`), static
  (`index.html` → `"static"`), and **.NET** (`.csproj`/`.sln` → `"dotnet"`, or
  `"maui"` when the csproj references Maui/uses mobile target frameworks →
  runner `"dotnet"`). Returns `requirements[]` (each a `PreviewRequirement`
  `{key,name,satisfied,detail,installable,installLabel,url}`), `ready` (all
  satisfied & deps installed), `needsInstall` (web node_modules missing), `how`
  (what running will do), and `message` (friendly text when unsupported).
- `install_deps(projectPath) -> ()` — `npm install`.
- `install_preview_requirement(key) -> ()` — preview-only installs: `node`/
  `dotnet` reuse `install_tool_inner` (brew/winget); `maui` runs `dotnet workload
  install maui`. Errors are `friendly||KINETEK_DEV||raw` (`preview_error`).
- `start_preview(projectPath) -> PreviewInfo` — takes `State<PreviewState>`.
  **web**: spawns the dev server (`npm run <script>`, env `BROWSER=none
  FORCE_COLOR=0`), scans stdout/stderr for the printed `http://localhost:PORT`
  (90s timeout), tracks the `Child` in `PreviewState`, returns `{id, url}` → the
  frontend opens a `WebviewWindow`. **static**: returns a `file://` URL.
  **.NET** (`start_dotnet_preview`): runs `dotnet build -nologo` (bounded); on
  failure returns `friendly||KINETEK_DEV||raw` (`classify_dotnet_failure` maps
  the build output to a plain reason); on success launches `dotnet run --no-build`
  detached (app opens in its own window) and returns `{id, url:""}` (empty url =
  native, no webview). The frontend (`PreviewDialog`) branches on `url`.
- `stop_preview(id) -> ()` — `kill_tree`: on Unix the child is a process-group
  leader (`process_group(0)`), killed with `libc::kill(-pid, SIGTERM)` so the
  real server isn't orphaned.

### Persistence & secrets
- `load_organization() -> Organization` / `save_organization(organization) -> ()`
  — JSON in the app **config dir** (`app.path().app_config_dir()`), keyed by
  bundle id (survives dev *and* release; localStorage would not, different
  origin).
- `set_secret(key, value)` / `get_secret(key) -> Option<String>` /
  `delete_secret(key)` — OS keychain via the `keyring` crate
  (apple-native / windows-native features).

### Git (local, shells out to system `git`)
- `git_status(projectPath) -> Option<GitStatus>` — null if not a repo; branch,
  dirty, ahead/behind vs `@{u}`, last commit subject + relative time.
- `git_changes(path) -> Vec<GitChange>` — porcelain → `{path, status}` (status is
  a friendly word: Untracked/Modified/Added/Deleted/Renamed/Changed).
- `git_remote(path) -> Option<String>` — origin URL → `owner/repo` slug
  (`parse_repo_slug` strips git@/https/ssh prefixes + `.git`).
- `git_commit(path, message) -> ()` — `add -A` then `commit -m`; special errors
  for "nothing to commit" and missing git identity.
- `git_push(path, token) -> ()` — pushes `HEAD:<branch>`. If `token` set and
  remote is github, uses `https://<token>@github.com/<slug>.git`, else
  `git push origin`. **Token scrubbed from any error** (`.replace(token,"***")`).
- `git_init(path) -> ()` — `git init -b main` (fallback `git init`); no-op if
  already a repo.
- `git_set_remote(path, url) -> ()` — add or `set-url` origin.
- `git_log(path, limit?) -> Vec<CommitInfo>` — see §6. `git log --all
  --date-order -n <limit|300>` with a `%x1f`-field / `%x1e`-record format.
- `git_clone(url, dest, token) -> ProjectInfo` — clones into `dest/<repo-name>`
  (errors if that folder exists). Authed clone uses a token URL, then **resets
  origin to the clean URL** so the token never lands in `.git/config`. Token
  scrubbed from errors. Returns a project card (frameworks via
  `detect_frameworks`).
- `git_diff(path, file?) -> String` — unified diff of local changes vs `HEAD`
  (staged + unstaged for tracked files; falls back to the index diff when there
  are no commits). An untracked single file is synthesized as an all-added diff
  so its contents still show. Rendered coloured by `DiffViewer`.
- `git_remove_remote(path) -> ()` — drops the `origin` remote (used after the
  GitHub repo is deleted); local files + history are kept.
- `git_refs(path) -> GitRefs` — `{current, detached, branches[], remotes[],
  tags[]}` (remotes exclude `*/HEAD`).
- `git_create_branch(path, name, at?, checkout) -> ()` — `git branch`/`checkout
  -b` [at a commit].
- `git_checkout(path, reference) -> ()` — switch branch/ref; friendly error when
  uncommitted changes conflict.
- `git_delete_branch(path, name, force) -> ()` — `-d`/`-D`; friendly "not fully
  merged" hint.
- `git_stashes(path) -> Vec<StashEntry>` (`{index, message}`),
  `git_stash_save(path, message?)` (`stash push --include-untracked`),
  `git_stash_apply(path, index, pop)` (apply/pop), `git_stash_drop(path, index)`.

### GitHub REST (`lib/github.ts`)
- `getGithubRepo(token, slug)` — one repo's metadata (e.g. to read visibility).
- `setGithubRepoVisibility(token, slug, isPrivate)` — PATCH `private` → updated repo.
- `deleteGithubRepo(token, slug)` — DELETE; needs the **`delete_repo`** scope
  (separate from `repo`) — a 403 is rethrown with that guidance. Callers also run
  `git_remove_remote` so the project becomes "not connected" but keeps its files.
- `gh()` returns `null` on `204 No Content` (DELETE) instead of parsing JSON.

### Files
- `read_dir(path) -> Vec<DirEntryInfo>` — folders first, A→Z; `hidden` flag for
  dotfiles.
- `write_file_text(path, content) -> ()` — in-app editor save (creates parent dirs).
- `check_syntax(path) -> Vec<Diagnostic>` — on-save syntax check for langs Monaco
  can't natively diagnose: Python (`python -m py_compile`, catches syntax +
  indentation) and Go (`gofmt -e`, parses → `file:line:col`). Returns `[]` when
  fine, Monaco-handled (js/ts/json/css/html), or the tool is missing — never
  blocks saving. `Diagnostic{line,column,message,severity}`.
- `detect_endpoints(path) -> Vec<Endpoint>` — heuristic route scan (the `regex`
  crate, `EndpointPatterns`/`scan_endpoints` walking the API folder, ≤1500 files)
  for Express/Fastify, NestJS decorators, FastAPI, Flask, ASP.NET ([Http*] +
  minimal-API .Map*), and Go (net/http/gin/chi). `Endpoint{method,route,file,line}`.
  Powers `ApiPanel`. Not a real parser — best-effort surface map.
- `detect_api_calls(path) -> Vec<ApiCall>` — the consumer mirror: scans the app
  for `fetch(...)` / `axios|api.get(...)` call sites → `ApiCall{method,url,file,
  line}`. Powers `ContractPanel`'s drift check (app↔API).
- `read_file_text(path) -> FileContent` — UTF-8 only; flags `binary`,
  `tooLarge`, `truncated`; caps ~2MB / 400k chars.
- `search_files(root, query) -> Vec<SearchHit>` — recursive, case-insensitive
  name match; skips noisy dirs (node_modules/.git/target/dist/etc); caps 400.
- `home_dir() -> String`.

### Open externally
- `open_in_editor(path, editor)` — editor ∈ vscode/cursor/zed/finder.
- `open_in_vscode(path)`, `open_in_file_manager(path)`.

### Logging
- `log_error(timestamp, context, message) -> ()` — appends to
  `kinetek-errors.log` at the repo root (path resolved via
  `env!("CARGO_MANIFEST_DIR").parent()`, fallback cwd). Gitignored.

---

## 2. Data model (Rust ⇄ TS)

Every struct is `#[serde(rename_all = "camelCase")]` unless trivially all-lower.
The TS mirrors live in `src/types.ts`. Keep them in lockstep by hand.

| Rust (`lib.rs`)   | TS (`types.ts`)  | Fields (TS, camelCase) |
|-------------------|------------------|------------------------|
| `ProjectInfo`     | `Project`        | id, name, path, summary, status, frameworks[], hasPreview?, stack? |
| `ProjectStack`    | `ProjectStack`   | app, api?, database? (set for assembled projects) |
| `Prerequisite`    | `Prerequisite`   | key, name, required, installed, version, autoInstallable, installHint, url |
| `GeneratedFile`   | `GeneratedFile`  | path, contents |
| `PreviewRequirement` | `PreviewRequirement` | key, name, satisfied, detail, installable, installLabel, url |
| `PreviewStatus`   | `PreviewStatus`  | previewable, kind, runner, script, needsInstall, requirements[], ready, message, how |
| `PreviewInfo`     | `PreviewInfo`    | id, url (empty = native, no webview) |
| `Folder`          | `Folder`         | id, name |
| `Settings`        | `Settings`       | defaultDir, defaultEditor, aiProvider, onboarded |
| `Organization`    | `Organization`   | projects[], folders[], assignments{}, settings |
| `ProjectContext`  | `ProjectContext` | name, readme, packageJson |
| `GitStatus`       | `GitStatus`      | branch, dirty, ahead, behind, lastCommit, lastCommitRelative |
| `GitChange`       | `GitChange`      | path, status |
| `CommitInfo`      | `Commit`         | hash, shortHash, parents[], refs[], isHead, author, email, dateIso, dateRelative, subject, body |
| `GitRefs`         | `GitRefs`        | current, detached, branches[], remotes[], tags[] |
| `StashEntry`      | `StashEntry`     | index, message |
| `DirEntryInfo`    | `DirEntry`       | name, path, isDir, hidden |
| `FileContent`     | `FileContent`    | content, truncated, binary, tooLarge, size |
| `Diagnostic`      | `Diagnostic`     | line, column, message, severity |
| `Endpoint`        | `Endpoint`       | method, route, file, line |
| `ApiCall`         | `ApiCall`        | method, url, file, line |
| `SearchHit`       | `SearchHit`      | name, path, isDir, rel |

`ProjectStatus` (TS only, the `status` string): `"Live" | "In Development" | "On Hold"`.

Frontend-only types (no Rust mirror): `Template` (now with `kinds: AppKind[]`,
`platforms: Platform[]`, `scaffold`), `Category`, `Purpose`, `WizardMode`,
`AiProvider`, `AppKind`, `Platform`, and `catalog.ts`'s `AppCategory`/`DatabaseOption`.

---

## 3. Persistence & secrets

- **Workspace** = one `Organization` JSON in the app config dir. App loads it on
  mount (sample data only in a plain browser), and **saves the whole thing on any
  change** — guarded by an `orgLoaded` flag so it never writes an empty object
  over the file before the initial load completes.
- **Scan-merge** keeps existing/edited cards and only ADDS newly-found ones
  (dedup by id = absolute path) — it never clobbers user edits.
- **Secrets** are never in the Organization JSON. AI keys → keychain as
  `apikey:<providerId>`; GitHub token → keychain as `github-token`
  (`GITHUB_TOKEN_KEY`). Same GitHub token is used for both REST API and push.

---

## 4. Frontend state & data flow

`App.tsx` is the single source of truth. State it owns:
- `projects: Project[]`, `folders: Folder[]`,
  `assignments: Record<projectId, folderId>`, `settings: Settings`
  — together they ARE the `Organization`.
- `view: ViewMode` (`"home" | "projects" | "explorer" | "github" | "terminal"`,
  default `"home"`) — primary page. `home` = the `DashboardHome` widget board;
  `projects` = the `Dashboard` grid (where the inspector + folders live);
  `terminal` = the lazy-loaded `TerminalView`.
- `selectedFolder: FolderSelection` (`"all" | "unfiled" | folderId`).
- `expandedId: string | null` — **selecting a project anywhere** (card or widget
  row) sets this; `ProjectPage` (full page) then takes over the entire content
  area. `expanded` is derived live from `projects` by id (tracks edits, clears on
  delete). There is no side inspector — `ProjectPanel` was removed. `ProjectPage`'s
  breadcrumb (`Projects › name`) calls `onBack` → clears `expandedId` + sets
  `view="projects"`. Its **Files** tab detects `app`/`api`/`database` subfolders
  (`readDir` on the root) and shows a part switcher that re-roots `FileBrowser`
  (keyed so it remounts) for instant App/API/Database browsing; clicking a file
  opens it in the lazy **Monaco `CodeEditor`** (edit + ⌘S save + diagnostics).
  **Proceed to IDE** is a split button → `onOpenPath(path, file?)` (App's
  `handleOpenPath` → `openInEditor(path, editor, file)`): whole project, the active
  part folder, or **"Open this file"** = the part folder as workspace + the file
  focused (`code <folder> <file>`). A **Preview** button → `onPreview` opens
  `PreviewDialog` for the `app/` part (assembled) or the root (flat).
- Dialog/transient flags: `wizardOpen`, `pendingDelete`, `previewProject`,
  `editingProject`, `settingsOpen`, `explainingId`, `scanning`, toasts.
- **First run:** `Settings.onboarded` (Rust `#[serde(default)]`, TS optional)
  gates a full-screen `Onboarding` page (`needsOnboarding = isTauri && orgLoaded
  && !onboarded`). It saves optional AI key + GitHub token to the keychain and
  the workspace defaults to settings. **Reset** (`handleReset`, surfaced in
  SettingsDialog's Danger zone) deletes every `apikey:<provider>` + the GitHub
  token from the keychain, clears the in-memory workspace, and sets
  `onboarded: false` (the save effect persists the wipe) → back to Onboarding.
  NB: `SettingsDialog.handleSave` spreads the existing `settings` so it doesn't
  drop `onboarded`.

Data flow: components are presentational and receive handlers as props. All
handlers (`handleScanFolder`, `handleCreated`, `handleConfirmDelete`,
`handlePreview`, `handleExplain`, etc.) live in `App.tsx` and call `lib/tauri.ts`
wrappers. `localNames` (set of on-disk project folder basenames) is computed in
App and passed to `GithubPage` to mark already-cloned repos as "Saved".

`notify(kind, message)` is the toast + log helper threaded everywhere; errors
also go to `logError` → the `kinetek-errors.log` file.

---

## 5. Key flows, step by step

### Create a project (wizard)
Two paths, both ending in a shared **stack → details → preflight → running** tail:
- **Framework funnel:** `appType` (Web/Mobile/Desktop, `AppTypeStep`) →
  `platform` (Mobile/Desktop only, `PlatformStep`) → `template`
  (`TemplateStep`, list = `frameworksFor(kind, platform)`).
- **Goal:** `category` → `purpose` (maps to an app template).
Then **`StackStep`** — optionally add an API (framework) and/or a database
(engine), both default "None". **Preflight** checks the *union* of app + API
prereqs (`loadPrereqs(ids[])`, deduped by key). `handleBuild` attaches a
`listen("project-output", …)` listener **before** invoking `create_project`
(app → API → database stream in order) → `RunningStep` shows the live terminal →
the card is added (with combined framework tags + `stack`). The flat-vs-monorepo
layout is decided backend-side by whether an API/DB was chosen.

### Preview
Card Preview button → App `setPreviewProject` → **`PreviewDialog`** (the single
entry for all preview). It calls `preview_status`, lists the `requirements[]`
(each satisfied or with a preview-only **Install** button →
`install_preview_requirement`, or a **Get it** link), plus an `npm install` row
when `needsInstall`. **Run** (enabled once `ready`) → `start_preview`:
- web/static (`info.url` set) → `openPreviewWindow` (a `WebviewWindow`); closing
  it → `stop_preview` (kills the dev server).
- .NET (`info.url === ""`) → built cleanly and launched in its own window; the
  dialog shows a "Built & launched" state.
On any failure the dialog shows the friendly reason and the raw build/install
output behind a "developer details" toggle (`splitPreviewError`). Genuinely
unsupported kinds (Expo, Rust/Go CLI, FastAPI) show a plain message and no Run.

### AI explain a card
✨ button → `read_project_context` → `explainProject(provider, key, context)`
(structured `{summary, status, tags}`) using the keychain key for
`settings.aiProvider` → updates the card. Prompts to Settings if no key.

### Save a repo from GitHub
GitHub page → "Save locally" → dest = `settings.defaultDir` or folder picker →
`git_clone(cloneUrl, dest, token)` → `handleCreated` adds the card (summary
seeded from repo description) → marked "Saved".

### Commit & push
GitPanel: commit message → `git_commit` → `git_push(path, token)`. Connect flow
when no remote: Link existing (filterable `listGithubRepos`) or Create new
(`createGithubRepo`, auto_init:false) → `git_set_remote` (runs `git_init -b main`
first if needed).

---

## 5a. The dashboard widget board

`DashboardHome.tsx` (the `home` landing) is **registry-driven**: a local
`widgets` array of `{ id, span, render }` mapped onto a `grid-cols-1
lg:grid-cols-6` grid. `span` is a Tailwind col-span (e.g. `lg:col-span-2`).
**To add a widget:** create a component under `components/widgets/`, then add one
entry to that array — no other wiring.

- All widgets share card chrome via `widgets/Widget.tsx` (`title`, optional
  `icon`/`action`, body) and a clickable `widgets/ProjectRow.tsx`.
- Current widgets: `QuickActionsWidget` (New/Scan/GitHub/Explorer),
  `StatsWidget` (counts), `RecentProjectsWidget` (first 6, newest-first),
  `NeedsAttentionWidget` (dirty or ahead), `ActivityWidget` (last 8 log entries
  via `useSyncExternalStore` on `logStore`).
- Git status for all real projects is fetched once by `hooks/useProjectStatuses.ts`
  (`Promise.all` of `gitStatus`, keyed by project id, re-runs when the set of
  paths changes, empty outside Tauri) and passed down to the widgets — so the
  board makes N git calls on load, not N-per-widget.
- Widget project rows call `onOpenProject` → App `setExpandedId` → full-page
  `ProjectPage`. Quick actions switch `view` or open the wizard.
- Roadmap: persisted layout / show-hide toggles / drag-reorder (the registry
  shape is ready for it; not built yet).

## 6. The commit-graph algorithm

`CommitGraph.tsx`. Backend `git_log` returns commits **newest-first** (children
before parents) with `parents[]` and `refs[]` (decorations; `HEAD -> x` sets
`isHead` and keeps `x`). Layout (`layout()`):

- Maintain `lanes: (hash|null)[]` — what each active lane is *waiting for*.
- For each commit (row): find the lane already waiting for it; else take the
  first `null` lane; else push a new lane. That index is the commit's `col`.
- Route to parents we actually have:
  - 0 parents → lane ends (`null`).
  - else first parent **keeps this lane** (→ straight vertical line); each extra
    parent opens a new lane (merge), unless one already waits for it.
- After each row, collapse duplicate reservations of the same parent
  (leftmost-wins) so two lanes don't both draw to one parent.
- Second pass builds edges `{fromRow,fromCol,toRow,toCol,color}` once every
  commit has a column. Edge colour = destination lane's colour (8-colour
  palette), so a branch reads as one colour down its length.

Rendering: rows are a normal list with `paddingLeft` = graph width; an
**absolutely-positioned SVG** sits behind them drawing edges (bezier across one
row height, then straight down) and node circles (filled if `isHead`). Constants:
`ROW_H=34`, `COL_W=16`, `PAD_X=14`. A detail pane (lg+) shows the selected
commit's full message/body/author/date/parents/refs.

Branches & stashes (our UI, Fork as feature-reference only): the History tab is
`RefsSidebar` (collapsible Branches/Remotes/Tags/Stashes — create-branch,
checkout, delete-branch, stash save/apply/pop/drop) beside `CommitGraph`, which
has a **"Create branch here"** action in its detail pane (creates at the selected
commit's hash and checks it out). Both take `refreshKey` + `onChanged`; ProjectPage
holds a `gitRefreshKey` and `bumpGit()` so a mutation in one reloads the other.
Remote rows checkout the DWIM short name (`origin/x` → `x`).

Roadmap: per-commit changed files via `git show --stat`; merge/rebase; push new branch upstream.

---

## 7. GitHub integration & auth

`src/lib/github.ts` (REST via plugin-http, so no CORS). `gh()` helper attaches
`Authorization: Bearer <token>`, `Accept: vnd.github+json`, API version header,
and turns 401/403 into messages that tell the user to use a **classic token with
the `repo` scope** (fine-grained tokens trip the 403 path).

- `getGithubUser(token) -> {login}` — validate + show `@login`.
- `listGithubRepos(token)` — owner repos, updated-first (used by GitPanel's link
  flow).
- `listAllGithubRepos(token)` — **every** accessible repo:
  `affiliation=owner,collaborator,organization_member`, paginated (per_page=100,
  ≤10 pages), de-duped by full name, newest-pushed first (used by GithubPage).
- `createGithubRepo(token, name, isPrivate)` — `auto_init:false`.
- `GithubRepo`: fullName, name, cloneUrl, private, description, language,
  updatedAt (pushed_at), htmlUrl, defaultBranch, stars, fork (`toRepo` mapper).

Auth model recap: plain `git push` uses the user's own creds; GitHub-over-HTTPS
uses the keychain token embedded in the URL **only at call time**, scrubbed from
errors, never persisted. The user has two accounts (Odyssi-Sec primary,
Odious-Sec secondary); the single keychain token decides which one is active.

Connected-repo management (in `GitPanel`, once a project has an `origin`): it
fetches `getGithubRepo` for the visibility badge, offers a **public/private
toggle** (`setGithubRepoVisibility`), and a **Delete repo** action that calls
`deleteGithubRepo` then `git_remove_remote` — the GitHub repo is gone but the
local files/history remain and the project shows as "not connected." Delete needs
the `delete_repo` token scope. New-repo creation already has a private/public
choice. **Local changes diff:** in `ProjectPage`'s Source-control tab, GitPanel's
changed-file rows are clickable (`onSelectChange`) and drive a `DiffViewer`
(`git_diff`) in the right pane — so you see exactly what changed vs the last
commit (what GitHub has). GitPanel renders without the diff pane in the narrow
side inspector (no `onSelectChange`).

---

## 8. AI generation (BYOK)

**Never embed Kinetek's own key** — it'd be extracted from the binary. All keys
are the user's, from the keychain. `src/lib/generate.ts` implements all 5
providers via plugin-http (3 request shapes):
- **Gemini** (`gemini-2.0-flash`) — `generateContent`, with `responseSchema` +
  `responseMimeType: application/json`.
- **OpenAI-compatible** `chat/completions` with `response_format: json_object`:
  Groq (`llama-3.3-70b-versatile`), OpenAI (`gpt-4o-mini`), OpenRouter
  (`openai/gpt-4o-mini`).
- **Anthropic Messages** (`claude-opus-4-8`) — `x-api-key` + `anthropic-version`.

All driven by a prompt that fully specifies the JSON shape
`{files:[{path,contents}]}`; `parseJsonLoose` tolerates stray prose. Providers
live in `src/lib/ai.ts` (`AI_PROVIDERS`); `composePrompt` is in
`src/lib/categories.ts`. The host for each provider is already in the http
capability allow-list — **add a host there if you add a provider**.

---

## 9. Templates & scaffolding

`src/lib/templates.ts` ids **must match** the `scaffold_for()` match arms in
`lib.rs`. Each template carries `kinds: AppKind[]`, `platforms: Platform[]`, and
`scaffold: "cli"|"files"|"placeholder"`. Current ids by category:
- **web:** react-vite, vue-vite, svelte-vite, solid-vite, preact-vite,
  vanilla-vite, nextjs, astro, angular, static-web
- **mobile:** react-native (Expo), flutter, maui, android-native*, ios-native*
- **desktop:** tauri, electron, maui, wpf, macos-native*
- **api:** node-express, nestjs, python-fastapi, flask, aspnet-core, go-module
- **tool:** rust-cli

(*`placeholder` — Kinetek can't CLI-scaffold true-native Android/iOS/macOS, so it
writes a starter folder + README pointing to Android Studio / Xcode. Everything
else is a real `Scaffold::Cli`/`Scaffold::Files`.) `template_prereqs(id)` declares
required tools (node/rust/dotnet/python/go/flutter + manual-only Android
Studio/Xcode). The funnel catalog (`src/lib/catalog.ts`) is data-driven —
**adding a framework = a `templates.ts` entry + a `scaffold_for` arm**, nothing
else. "Build by goal" categories + purposes are separate (`src/lib/categories.ts`).

---

## 10. Capabilities / permissions

`src-tauri/capabilities/default.json` (window `main`):
- `core:default`, `core:window:allow-start-dragging` (title-bar drag),
  `core:webview:allow-create-webview-window` (preview window).
- `dialog:default`.
- `shell:allow-open` + scoped `shell:allow-execute` for `code`, `npm`, `npx`,
  `dotnet`.
- `http:default` scoped to: generativelanguage.googleapis.com, api.groq.com,
  openrouter.ai, api.anthropic.com, api.openai.com, **api.github.com**.

Principle: do heavy work in a focused Rust command rather than widening these
scopes. New external API → add its host here.

---

## 11. Build, run, release

```bash
npm run dev          # vite only (browser; Tauri APIs are no-ops via isTauri())
npm run build        # tsc + vite build  — run after EVERY change
npm run typecheck    # tsc --noEmit
npm run tauri:dev    # full desktop app, hot reload
npm run tauri:build  # release .app + .dmg → src-tauri/target/release/bundle/
cd src-tauri && cargo check   # Rust-only typecheck — run after EVERY Rust change
```

Release notes: bundle id `com.kinetek.app` (Tauri warns it ends in `.app`;
cosmetic, rename candidate `com.kinetek.desktop`). Builds are **unsigned** →
Gatekeeper prompts on first open (right-click → Open). `isTauri()` guards
desktop-only paths so the app still renders in a browser with sample data.

---

## 12. Conventions checklist (quick)

- [ ] New backend capability → Rust command + register in `generate_handler!` +
      typed wrapper in `lib/tauri.ts` (never `invoke` directly).
- [ ] New/changed struct → `#[serde(rename_all="camelCase")]` + mirror in
      `types.ts`.
- [ ] Long Rust work → `spawn_blocking`, `Result<T, String>` with friendly errors.
- [ ] Process exec → `make_command()`.
- [ ] Secret → keychain, never disk/binary.
- [ ] New external API host → add to `capabilities/default.json` http allow-list.
- [ ] New icon → `components/icons.tsx` (inline SVG, no dep).
- [ ] Only Tailwind tokens that exist in `tailwind.config.js`.
- [ ] New top-level page → `NAV_ITEMS` + `ViewMode` + App `view` switch.
- [ ] Verify: `npm run build` AND `cargo check` clean before "done".
- [ ] Update `CLAUDE.md` / this file when you add a feature or learn a gotcha.
```
