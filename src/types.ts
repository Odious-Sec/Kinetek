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
}

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

/** Whether/how a project can be previewed (mirrors Rust). */
export interface PreviewStatus {
  previewable: boolean;
  kind: string;
  runner: string;
  script: string | null;
  needsInstall: boolean;
  nodeInstalled: boolean;
  message: string;
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
  templateId: string;
  summary: string;
  status: ProjectStatus;
  frameworks: string[];
}
