import type { AppKind, Platform, Template } from "../types";
import { TEMPLATES } from "./templates";

/**
 * The New Project funnel catalog: app categories → platforms → frameworks, plus
 * the API framework list and database engines. All data-driven — adding a
 * framework is just an entry in `templates.ts` (+ a matching `scaffold_for` arm).
 */

export interface AppCategory {
  kind: AppKind;
  name: string;
  glyph: string;
  description: string;
  accent: string;
  /** Platforms to choose between; omit/empty to skip the platform step. */
  platforms?: { id: Platform; name: string; glyph: string }[];
}

/** The first funnel step (framework path). API is handled in its own step. */
export const APP_CATEGORIES: AppCategory[] = [
  {
    kind: "web",
    name: "Web App",
    glyph: "🌐",
    description: "Runs in the browser — sites, dashboards, single-page apps.",
    accent: "from-sky-500/20 to-cyan-400/10",
  },
  {
    kind: "mobile",
    name: "Mobile App",
    glyph: "📱",
    description: "iOS and Android — cross-platform or fully native.",
    accent: "from-violet-500/20 to-fuchsia-400/10",
    platforms: [
      { id: "cross", name: "Cross-platform", glyph: "🔀" },
      { id: "android", name: "Android", glyph: "🤖" },
      { id: "ios", name: "iOS", glyph: "" },
    ],
  },
  {
    kind: "desktop",
    name: "Desktop App",
    glyph: "🖥️",
    description: "Windows and macOS — cross-platform or native.",
    accent: "from-amber-500/20 to-orange-400/10",
    platforms: [
      { id: "cross", name: "Cross-platform", glyph: "🔀" },
      { id: "windows", name: "Windows", glyph: "🪟" },
      { id: "macos", name: "macOS", glyph: "🍎" },
    ],
  },
];

/** Frameworks for a chosen category (+ platform). Cross-platform ones always show. */
export function frameworksFor(kind: AppKind, platform?: Platform): Template[] {
  return TEMPLATES.filter(
    (t) =>
      t.kinds.includes(kind) &&
      (!platform ||
        platform === "web" ||
        t.platforms.includes(platform) ||
        t.platforms.includes("cross"))
  );
}

/** The frameworks offered in the optional API step. */
export const API_FRAMEWORKS: Template[] = TEMPLATES.filter((t) =>
  t.kinds.includes("api")
);

export interface DatabaseOption {
  id: string;
  name: string;
  family: "SQL" | "NoSQL";
  glyph: string;
  description: string;
}

/** Database engines offered in the optional Database step. */
export const DATABASES: DatabaseOption[] = [
  {
    id: "postgresql",
    name: "PostgreSQL",
    family: "SQL",
    glyph: "🐘",
    description: "The popular, powerful open-source SQL database.",
  },
  {
    id: "mysql",
    name: "MySQL",
    family: "SQL",
    glyph: "🐬",
    description: "A widely-used relational SQL database.",
  },
  {
    id: "sqlite",
    name: "SQLite",
    family: "SQL",
    glyph: "📦",
    description: "A zero-config, file-based SQL database — no server.",
  },
  {
    id: "mongodb",
    name: "MongoDB",
    family: "NoSQL",
    glyph: "🍃",
    description: "A flexible, document-oriented NoSQL database.",
  },
];

export function getDatabase(id: string): DatabaseOption | undefined {
  return DATABASES.find((d) => d.id === id);
}
