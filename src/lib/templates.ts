import type { Template } from "../types";

/**
 * The set of project templates the bootstrapper can scaffold.
 *
 * The `id` here must match a branch in both `scaffold_for()` and
 * `template_prereqs()` in `src-tauri/src/lib.rs`. Everything else is
 * presentation only — the actual prerequisite list comes from the backend.
 */
export const TEMPLATES: Template[] = [
  {
    id: "react-vite",
    name: "React + Vite",
    description: "A lightning-fast React single-page app with TypeScript.",
    frameworks: ["React", "Vite", "TypeScript"],
    glyph: "⚛️",
    requires: "Node.js",
    accent: "from-sky-500/20 to-cyan-400/10",
  },
  {
    id: "vue-vite",
    name: "Vue + Vite",
    description: "A reactive Vue 3 app with the Composition API and TypeScript.",
    frameworks: ["Vue", "Vite", "TypeScript"],
    glyph: "💚",
    requires: "Node.js",
    accent: "from-emerald-500/20 to-green-400/10",
  },
  {
    id: "svelte-vite",
    name: "Svelte + Vite",
    description: "A compiled, no-virtual-DOM Svelte app with TypeScript.",
    frameworks: ["Svelte", "Vite", "TypeScript"],
    glyph: "🧡",
    requires: "Node.js",
    accent: "from-orange-500/20 to-amber-400/10",
  },
  {
    id: "nextjs",
    name: "Next.js",
    description: "A full-stack React framework with the App Router & Tailwind.",
    frameworks: ["Next.js", "React", "TypeScript"],
    glyph: "▲",
    requires: "Node.js",
    accent: "from-slate-400/20 to-slate-200/10",
  },
  {
    id: "react-native",
    name: "React Native (Expo)",
    description: "A cross-platform mobile app scaffolded with Expo.",
    frameworks: ["React Native", "Expo"],
    glyph: "📱",
    requires: "Node.js",
    accent: "from-violet-500/20 to-fuchsia-400/10",
  },
  {
    id: "node-express",
    name: "Node + Express",
    description: "A minimal Node.js HTTP server with an Express skeleton.",
    frameworks: ["Node.js", "Express"],
    glyph: "🟩",
    requires: "Node.js",
    accent: "from-lime-500/20 to-green-400/10",
  },
  {
    id: "aspnet-core",
    name: "ASP.NET Core API",
    description: "A C# web API with the .NET minimal hosting model.",
    frameworks: [".NET", "C#", "Web API"],
    glyph: "🌐",
    requires: ".NET SDK",
    accent: "from-teal-500/20 to-cyan-400/10",
  },
  {
    id: "python-fastapi",
    name: "Python FastAPI",
    description: "A modern, async Python web API with automatic docs.",
    frameworks: ["Python", "FastAPI"],
    glyph: "🐍",
    requires: "Python 3",
    accent: "from-blue-500/20 to-yellow-400/10",
  },
  {
    id: "rust-cli",
    name: "Rust CLI",
    description: "A fast, safe command-line program built with Cargo.",
    frameworks: ["Rust", "Cargo"],
    glyph: "🦀",
    requires: "Rust",
    accent: "from-orange-600/20 to-red-400/10",
  },
  {
    id: "go-module",
    name: "Go Module",
    description: "A simple, statically-compiled Go program.",
    frameworks: ["Go"],
    glyph: "🐹",
    requires: "Go",
    accent: "from-cyan-500/20 to-sky-400/10",
  },
  {
    id: "static-web",
    name: "Static Web",
    description: "A plain HTML/CSS/JS site — no build step, no dependencies.",
    frameworks: ["HTML", "CSS", "JavaScript"],
    glyph: "🌍",
    requires: "Nothing",
    accent: "from-indigo-500/20 to-purple-400/10",
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
