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
- `create_project(parentDir, projectName, templateId, summary, status, frameworks) -> ProjectInfo`
  Takes the `AppHandle`. Runs the template's scaffolder (CLI or file-writer) and
  **emits a `project-output` event per line** (`{line, stream}`) for the live
  terminal. stdout/stderr also collected so failures report captured output.
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
- `install_tool(toolKey) -> ()` — brew (macOS) / winget (Windows); manual-only
  tools (Android Studio, Xcode) return an error pointing to a download URL.

### Delete
- `delete_project(path) -> ()` — move to Trash via `NSFileManager` (macOS) /
  platform trash. `guard_deletable` refuses shallow/system/home paths.
- `delete_project_permanently(path) -> ()` — `fs::remove_dir_all`; the fallback
  for iCloud-evicted placeholders Finder won't trash.

### Preview (run locally)
- `preview_status(projectPath) -> PreviewStatus` — detects a `dev`/`start`/
  `serve` npm script (kind `"web"`, runner `"node"`) or `index.html` (kind
  `"static"`); reports `nodeInstalled` and `needsInstall` (no node_modules).
- `install_deps(projectPath) -> ()` — `npm install`.
- `start_preview(projectPath) -> PreviewInfo` — takes `State<PreviewState>`.
  Spawns the dev server (`npm run <script>`, env `BROWSER=none FORCE_COLOR=0`),
  **scans stdout/stderr for the printed `http://localhost:PORT`** (90s timeout),
  stores the `Child` in `PreviewState` (a `Mutex<HashMap<id, Child>>`), returns
  `{id, url}`. The frontend then opens a `WebviewWindow` at that URL.
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

### Files (read-only)
- `read_dir(path) -> Vec<DirEntryInfo>` — folders first, A→Z; `hidden` flag for
  dotfiles.
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
| `ProjectInfo`     | `Project`        | id, name, path, summary, status, frameworks[], hasPreview? |
| `Prerequisite`    | `Prerequisite`   | key, name, required, installed, version, autoInstallable, installHint, url |
| `GeneratedFile`   | `GeneratedFile`  | path, contents |
| `PreviewStatus`   | `PreviewStatus`  | previewable, kind, runner, script, needsInstall, nodeInstalled, message |
| `PreviewInfo`     | `PreviewInfo`    | id, url |
| `Folder`          | `Folder`         | id, name |
| `Settings`        | `Settings`       | defaultDir, defaultEditor, aiProvider |
| `Organization`    | `Organization`   | projects[], folders[], assignments{}, settings |
| `ProjectContext`  | `ProjectContext` | name, readme, packageJson |
| `GitStatus`       | `GitStatus`      | branch, dirty, ahead, behind, lastCommit, lastCommitRelative |
| `GitChange`       | `GitChange`      | path, status |
| `CommitInfo`      | `Commit`         | hash, shortHash, parents[], refs[], isHead, author, email, dateIso, dateRelative, subject, body |
| `DirEntryInfo`    | `DirEntry`       | name, path, isDir, hidden |
| `FileContent`     | `FileContent`    | content, truncated, binary, tooLarge, size |
| `SearchHit`       | `SearchHit`      | name, path, isDir, rel |

`ProjectStatus` (TS only, the `status` string): `"Live" | "In Development" | "On Hold"`.

Frontend-only types (no Rust mirror): `Template`, `Category`, `Purpose`,
`WizardMode`, `AiProvider`.

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
- `view: ViewMode` (`"dashboard" | "explorer" | "github"`) — primary page.
- `selectedFolder: FolderSelection` (`"all" | "unfiled" | folderId`).
- `inspectProject` — which project the right-side `ProjectPanel` shows (derived
  live as `inspected` from `projects` by id, so it tracks edits and auto-closes
  on delete).
- `expandedId: string | null` — when set, `ProjectPage` (full page) takes over
  the entire content area; `expanded` is derived live the same way.
- Dialog/transient flags: `wizardOpen`, `pendingDelete`, `pendingInstall`,
  `editingProject`, `settingsOpen`, `explainingId`, `scanning`, toasts.

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
Wizard (`ProjectWizard.tsx`) → either framework-first or goal-first
(Category→Purpose→template). Details step (location prefilled from
`settings.defaultDir`) → `handleBuild` attaches a `listen("project-output", …)`
listener **before** invoking `create_project` (so no early lines are missed) →
`RunningStep` renders the live auto-scrolling terminal (stderr amber) → on
success the card is added; listener torn down in `finally` + on unmount.

### Preview
Card Preview button → `preview_status` → if `needsInstall`, a ConfirmDialog
offers `install_deps` → `start_preview` → `openPreviewWindow` (a dedicated
`WebviewWindow`). Closing the window → `stop_preview` (kills the dev server).
Not previewable: mobile (Expo), CLI (Rust/Go), FastAPI/.NET — each returns a
clear message.

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

Roadmap: per-commit changed files via `git show --stat`; branch checkout.

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
`lib.rs`. Current ids: `react-vite`, `vue-vite`, `svelte-vite`, `nextjs`,
`react-native`, `node-express`, `aspnet-core`, `python-fastapi`, `rust-cli`,
`go-module`, `static-web`. `template_prereqs(id)` declares required tools (node,
rust, dotnet, python, plus manual-only Android Studio / Xcode for mobile).
Scaffolders are either `Scaffold::Cli{program,args}` (runs the framework CLI) or
`Scaffold::Files(files)` (writes a starter file set). "Build by goal" categories
+ purposes live in `src/lib/categories.ts` and map a purpose → a template id.

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
