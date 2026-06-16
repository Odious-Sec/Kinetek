/**
 * Shared domain types for Kinetek.
 *
 * These mirror the Rust structs in `src-tauri/src/lib.rs` (serialized as
 * camelCase). Keep the two in sync when you change a field.
 */

export type ProjectStatus = "Live" | "In Development" | "On Hold";

export const PROJECT_STATUSES: ProjectStatus[] = [
  "Live",
  "In Development",
  "On Hold",
];

/** A single project rendered as a card on the dashboard. */
export interface Project {
  /** Stable unique id (the absolute path is used as the id). */
  id: string;
  /** Folder / display name. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Customizable, non-technical "Plain English Summary". */
  summary: string;
  status: ProjectStatus;
  /** Framework tags, e.g. ["React", "Vite", "Tauri"]. */
  frameworks: string[];
  /** Whether the project exposes a local dev preview (heuristic). */
  hasPreview?: boolean;
  /** Present for projects Kinetek assembled from app/API/database parts. */
  stack?: ProjectStack;
}

/** The kind of thing a framework builds (drives the wizard funnel). */
export type AppKind = "web" | "mobile" | "desktop" | "api" | "tool";

/** A target platform a framework can produce for. */
export type Platform =
  | "web"
  | "android"
  | "ios"
  | "windows"
  | "macos"
  | "linux"
  | "cross";

/** A bootstrapping template offered by the New Project wizard. */
export interface Template {
  id: string;
  name: string;
  /** Short, human description shown in the wizard. */
  description: string;
  /** Tags pre-filled onto the created project card. */
  frameworks: string[];
  /** Emoji glyph used as a lightweight icon. */
  glyph: string;
  /** The CLI tool this template drives (informational, shown to the user). */
  requires: string;
  accent: string;
  /** Which app categories this framework serves (web/mobile/desktop/api/tool). */
  kinds: AppKind[];
  /** Platforms it can target (used to filter after a platform is chosen). */
  platforms: Platform[];
  /** How Kinetek creates it: a real CLI/file scaffold, or a guided placeholder. */
  scaffold: "cli" | "files" | "placeholder";
}

/** The multi-part makeup of a project (mirrors Rust ProjectStack). */
export interface ProjectStack {
  /** App framework template id. */
  app: string;
  /** API framework template id, if one was added. */
  api?: string | null;
  /** Database engine id, if one was added. */
  database?: string | null;
}

/** Which entry path the New Project wizard is taking. */
export type WizardMode = "framework" | "goal";

/** A concrete thing-to-build within a category (e.g. "Personal budget"). */
export interface Purpose {
  id: string;
  name: string;
  /** Short blurb shown in the purpose list. */
  description: string;
  /** Maps to a TEMPLATES id in lib/templates.ts. */
  templateId: string;
  /** Prefilled plain-English summary for the new project. */
  summary: string;
  /** One-line goal used when composing the AI expansion prompt. */
  goal: string;
  /** Concrete starter pieces the AI should produce (prompt bullets). */
  starter: string[];
}

/** A top-level goal category (Finance, Fun, …). */
export interface Category {
  id: string;
  name: string;
  glyph: string;
  /** Tailwind gradient classes for the card wash. */
  accent: string;
  description: string;
  purposes: Purpose[];
}

/** An in-app organizational folder (virtual grouping, not a disk folder). */
export interface Folder {
  id: string;
  name: string;
}

/** Non-secret user preferences (mirrors Rust). */
export interface Settings {
  defaultDir: string | null;
  /** "vscode" | "cursor" | "zed" | "finder". */
  defaultEditor: string;
  /** AI provider id (see lib/ai.ts). */
  aiProvider: string;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultDir: null,
  defaultEditor: "vscode",
  aiProvider: "gemini",
};

/** The whole persisted workspace: cards, folders, assignments, settings. */
export interface Organization {
  projects: Project[];
  folders: Folder[];
  assignments: Record<string, string>;
  settings: Settings;
}

/** Local git status for a project (mirrors Rust). */
export interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  lastCommitRelative: string | null;
}

/** One commit in the history, for the visual graph (mirrors Rust). */
export interface Commit {
  hash: string;
  shortHash: string;
  /** Parent hashes (first = mainline). Merge commits have 2+. */
  parents: string[];
  /** Branch / tag names decorating this commit. */
  refs: string[];
  /** Whether HEAD points at this commit. */
  isHead: boolean;
  author: string;
  email: string;
  dateIso: string;
  dateRelative: string;
  subject: string;
  body: string;
}

/** Branches / remote-tracking branches / tags for the refs sidebar (mirrors Rust). */
export interface GitRefs {
  /** Current branch, or "HEAD" when detached. */
  current: string;
  detached: boolean;
  branches: string[];
  /** Remote-tracking branches, e.g. "origin/main". */
  remotes: string[];
  tags: string[];
}

/** A saved stash entry (mirrors Rust). */
export interface StashEntry {
  index: number;
  message: string;
}

/** A directory entry for the visual file Explorer (mirrors Rust). */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  hidden: boolean;
}

/** An uncommitted change (mirrors Rust). */
export interface GitChange {
  path: string;
  status: string;
}

/** A file-search match (mirrors Rust). */
export interface SearchHit {
  name: string;
  path: string;
  isDir: boolean;
  /** Path relative to the search root, for display. */
  rel: string;
}

/** An editor syntax diagnostic from the backend on-save check (mirrors Rust). */
export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  /** "error" | "warning". */
  severity: string;
}

/** A file's text for the read-only viewer (mirrors Rust). */
export interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

/** Small project context used to drive AI summaries. */
export interface ProjectContext {
  name: string;
  readme: string | null;
  packageJson: string | null;
}

/** One thing a preview needs in order to run (mirrors Rust). */
export interface PreviewRequirement {
  /** Key understood by install_preview_requirement ("node" | "dotnet" | "maui"). */
  key: string;
  name: string;
  satisfied: boolean;
  /** Version when satisfied, or a hint about what's missing. */
  detail: string;
  /** Kinetek can install it on this machine (preview-only). */
  installable: boolean;
  installLabel: string;
  url: string;
}

/** Whether/how a project can be previewed (mirrors Rust). */
export interface PreviewStatus {
  previewable: boolean;
  /** "web" | "static" | "dotnet" | "maui" | "unsupported" | "unknown". */
  kind: string;
  /** "node" | "static" | "dotnet" | "none". */
  runner: string;
  script: string | null;
  needsInstall: boolean;
  requirements: PreviewRequirement[];
  /** All requirements satisfied (and deps installed) — ready to run. */
  ready: boolean;
  message: string;
  /** What the preview will actually do. */
  how: string;
}

/** A started preview: the URL to load and the id used to stop it. */
export interface PreviewInfo {
  id: string;
  url: string;
}

/** A file produced by AI generation, written into the project on Apply. */
export interface GeneratedFile {
  /** Path relative to the project root. */
  path: string;
  contents: string;
}

/** A BYOK AI provider option for the generation step. */
export interface AiProvider {
  id: string;
  name: string;
  /** Whether the provider offers a usable free tier. */
  free: boolean;
  /** Where the user gets their own key. */
  keyUrl: string;
  note: string;
}

/** Install/availability state of a tool a template needs (mirrors Rust). */
export interface Prerequisite {
  key: string;
  name: string;
  required: boolean;
  installed: boolean;
  version: string | null;
  /** Can Kinetek install it via a package manager? */
  autoInstallable: boolean;
  installHint: string;
  /** URL to open for a manual install (may be empty). */
  url: string;
}

/** Payload sent to the Rust `create_project` command. */
export interface CreateProjectArgs {
  parentDir: string;
  projectName: string;
  /** App framework template id. */
  appTemplateId: string;
  /** Optional API framework template id. */
  apiTemplateId?: string | null;
  /** Optional database engine id (e.g. "postgresql"). */
  databaseEngine?: string | null;
  summary: string;
  status: ProjectStatus;
  frameworks: string[];
}
