import type { Project } from "../types";

/**
 * Seed data so the dashboard looks alive on first launch (and in a plain
 * browser, outside the Tauri webview). Real projects come from `scan_projects`.
 */
export const SAMPLE_PROJECTS: Project[] = [
  {
    id: "sample-aurora",
    name: "aurora-storefront",
    path: "~/Developer/aurora-storefront",
    summary:
      "The online shop where customers browse and buy. Currently live and taking orders.",
    status: "Live",
    frameworks: ["Next.js", "React", "TypeScript"],
    hasPreview: true,
  },
  {
    id: "sample-pulse",
    name: "pulse-mobile",
    path: "~/Developer/pulse-mobile",
    summary:
      "The companion phone app that sends activity notifications. Still being built.",
    status: "In Development",
    frameworks: ["React Native", "Expo"],
    hasPreview: false,
  },
  {
    id: "sample-ledger",
    name: "ledger-api",
    path: "~/Developer/ledger-api",
    summary:
      "The behind-the-scenes service that keeps track of payments and balances.",
    status: "Live",
    frameworks: [".NET", "C#", "Web API"],
    hasPreview: true,
  },
  {
    id: "sample-atlas",
    name: "atlas-prototype",
    path: "~/Developer/atlas-prototype",
    summary:
      "An early experiment for a mapping feature. Paused while we focus elsewhere.",
    status: "On Hold",
    frameworks: ["React", "Vite"],
    hasPreview: true,
  },
];
