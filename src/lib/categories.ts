import type { Category, Purpose } from "../types";

/**
 * The "Build by goal" taxonomy: Category → Purpose. Each purpose maps to one of
 * the framework templates (see lib/templates.ts) and carries the ingredients
 * for an AI "expand this into a starter" prompt.
 *
 * This is intentionally data-only — the wizard turns a Purpose into a real
 * project by scaffolding `templateId`, then (later) handing `composePrompt(...)`
 * to the user's chosen AI backend.
 */
export const CATEGORIES: Category[] = [
  {
    id: "finance",
    name: "Finance",
    glyph: "💰",
    accent: "from-emerald-500/20 to-teal-400/10",
    description: "Money, budgets, invoices and reporting.",
    purposes: [
      {
        id: "personal-budget",
        name: "Personal budget",
        description: "Track income, spending and savings goals.",
        templateId: "react-vite",
        summary: "A personal budgeting dashboard for tracking spending and savings.",
        goal: "Help one person see where their money goes and stay on budget.",
        starter: [
          "A dashboard layout with cards for balance, income and expenses",
          "A simple in-memory list of transactions with category + amount",
          "A form to add a transaction and a monthly total summary",
        ],
      },
      {
        id: "invoicing",
        name: "Invoicing for freelancers",
        description: "Create and send simple invoices.",
        templateId: "nextjs",
        summary: "An invoicing tool that lets freelancers create and track invoices.",
        goal: "Let a freelancer create an invoice and mark it paid or unpaid.",
        starter: [
          "An invoice list page and an invoice detail/create page",
          "A typed Invoice model (client, line items, total, status)",
          "A route/API stub for creating an invoice (no real persistence yet)",
        ],
      },
      {
        id: "corporate-finance",
        name: "Corporate finance API",
        description: "A reporting service for finance teams.",
        templateId: "python-fastapi",
        summary: "A backend API that serves financial reports for a finance team.",
        goal: "Expose endpoints that return summarized financial figures.",
        starter: [
          "Endpoints for /accounts and /reports/summary returning sample data",
          "Pydantic models for an account and a period summary",
          "A small in-memory data layer with a TODO to swap in a real database",
        ],
      },
    ],
  },
  {
    id: "fun",
    name: "Fun & Games",
    glyph: "🎮",
    accent: "from-violet-500/20 to-fuchsia-400/10",
    description: "Games, quizzes and playful apps.",
    purposes: [
      {
        id: "arcade-game",
        name: "Browser arcade game",
        description: "A small canvas game, no build step.",
        templateId: "static-web",
        summary: "A lightweight browser arcade game built with plain HTML/JS.",
        goal: "Get a playable canvas game loop running in the browser.",
        starter: [
          "A <canvas> with a requestAnimationFrame game loop",
          "Keyboard input handling and a player sprite that moves",
          "A score counter and a simple game-over reset",
        ],
      },
      {
        id: "trivia",
        name: "Trivia quiz",
        description: "Multiple-choice quiz with scoring.",
        templateId: "react-vite",
        summary: "A trivia quiz app that asks questions and tracks the score.",
        goal: "Let a player answer multiple-choice questions and see their score.",
        starter: [
          "A hard-coded list of questions with options and the correct index",
          "A question card component with answer buttons and feedback",
          "Score tracking and an end-of-quiz results screen",
        ],
      },
      {
        id: "party-app",
        name: "Party game (mobile)",
        description: "A pass-the-phone party game.",
        templateId: "react-native",
        summary: "A pass-and-play party game for phones.",
        goal: "Run a simple multi-player, pass-the-phone party round.",
        starter: [
          "A home screen to add players and a 'start round' button",
          "A round screen that cycles through players with a prompt",
          "Simple navigation between home and round screens",
        ],
      },
    ],
  },
  {
    id: "productivity",
    name: "Productivity",
    glyph: "✅",
    accent: "from-sky-500/20 to-cyan-400/10",
    description: "Tasks, notes and automation.",
    purposes: [
      {
        id: "todo",
        name: "Task manager",
        description: "Organize tasks and to-dos.",
        templateId: "svelte-vite",
        summary: "A task manager for organizing daily to-dos.",
        goal: "Let someone add, complete and filter tasks.",
        starter: [
          "A task store with add / toggle-complete / delete",
          "An input to add a task and a list with checkboxes",
          "Filter tabs for All / Active / Done",
        ],
      },
      {
        id: "notes",
        name: "Notes app",
        description: "Write and organize markdown notes.",
        templateId: "vue-vite",
        summary: "A notes app for writing and organizing markdown notes.",
        goal: "Let a user create notes and view them in a list.",
        starter: [
          "A sidebar list of notes and a main editor pane",
          "Reactive state for the selected note and its content",
          "A 'new note' action with an in-memory notes array",
        ],
      },
      {
        id: "automation-cli",
        name: "Automation CLI",
        description: "A fast command-line helper.",
        templateId: "rust-cli",
        summary: "A command-line tool that automates a repetitive task.",
        goal: "Provide a CLI with a couple of useful subcommands.",
        starter: [
          "Argument parsing for at least one subcommand",
          "One worked example command that prints a result",
          "A clear TODO marking where to add real automation logic",
        ],
      },
    ],
  },
  {
    id: "health",
    name: "Health & Fitness",
    glyph: "🏃",
    accent: "from-rose-500/20 to-orange-400/10",
    description: "Tracking workouts, habits and nutrition.",
    purposes: [
      {
        id: "workout-tracker",
        name: "Workout tracker (mobile)",
        description: "Log workouts on your phone.",
        templateId: "react-native",
        summary: "A mobile app for logging workouts and sets.",
        goal: "Let someone log a workout and see their history.",
        starter: [
          "A screen listing logged workouts",
          "A form to add a workout (exercise, sets, reps)",
          "In-memory state with navigation between list and add screens",
        ],
      },
      {
        id: "habit",
        name: "Habit tracker",
        description: "Build daily habits with streaks.",
        templateId: "react-vite",
        summary: "A daily habit tracker that shows streaks.",
        goal: "Let a user check off daily habits and see streaks grow.",
        starter: [
          "A list of habits with a daily check-off toggle",
          "A streak counter per habit",
          "An 'add habit' form with in-memory state",
        ],
      },
      {
        id: "nutrition-api",
        name: "Nutrition API",
        description: "Serve calorie and macro data.",
        templateId: "python-fastapi",
        summary: "A backend API that returns nutrition and calorie data.",
        goal: "Expose endpoints for foods and a daily intake summary.",
        starter: [
          "Endpoints for /foods and /intake returning sample data",
          "Pydantic models for a food item and a daily total",
          "An in-memory store with a TODO to connect a real dataset",
        ],
      },
    ],
  },
  {
    id: "education",
    name: "Education",
    glyph: "📚",
    accent: "from-amber-500/20 to-yellow-400/10",
    description: "Learning, courses and study tools.",
    purposes: [
      {
        id: "flashcards",
        name: "Flashcards",
        description: "Study with flippable cards.",
        templateId: "vue-vite",
        summary: "A flashcards app for studying any subject.",
        goal: "Let a learner flip through a deck and mark cards known.",
        starter: [
          "A deck of cards (front/back) in reactive state",
          "A card component that flips on click",
          "Next / previous controls and a 'known' marker",
        ],
      },
      {
        id: "course-platform",
        name: "Course platform",
        description: "Host lessons and track progress.",
        templateId: "nextjs",
        summary: "An online platform for browsing courses and lessons.",
        goal: "Let a student browse courses and open a lesson.",
        starter: [
          "A courses index page and a lesson detail route",
          "A typed Course/Lesson model with sample content",
          "A simple 'mark lesson complete' toggle (in-memory)",
        ],
      },
      {
        id: "coding-playground",
        name: "Coding lesson page",
        description: "An interactive lesson, no build step.",
        templateId: "static-web",
        summary: "An interactive coding lesson page in plain HTML/JS.",
        goal: "Present a lesson with a runnable code snippet.",
        starter: [
          "A lesson layout with explanation text and a code area",
          "A 'run' button that evaluates the snippet and shows output",
          "Basic styling so it reads like a tutorial",
        ],
      },
    ],
  },
  {
    id: "devtools",
    name: "Developer Tools",
    glyph: "🛠️",
    accent: "from-indigo-500/20 to-purple-400/10",
    description: "APIs, CLIs and dashboards for builders.",
    purposes: [
      {
        id: "api-service",
        name: "REST API service",
        description: "A small backend service.",
        templateId: "node-express",
        summary: "A REST API service with a couple of starter endpoints.",
        goal: "Expose a small, well-structured REST API.",
        starter: [
          "Routes for GET /health and a sample resource collection",
          "A separated router/handler structure",
          "A TODO marking where to add a database",
        ],
      },
      {
        id: "cli-tool",
        name: "Developer CLI",
        description: "A fast, distributable CLI.",
        templateId: "go-module",
        summary: "A developer CLI tool written in Go.",
        goal: "Provide a CLI that performs one useful developer task.",
        starter: [
          "Flag/argument parsing for one command",
          "A worked example that prints a result",
          "A clear TODO for the real command logic",
        ],
      },
      {
        id: "status-dashboard",
        name: "Status dashboard",
        description: "Visualize service health.",
        templateId: "react-vite",
        summary: "A dashboard that visualizes service or project status.",
        goal: "Show a grid of services with their current status.",
        starter: [
          "A grid of status cards (name, state, last-checked)",
          "Sample data and a color-coded status badge",
          "A refresh button wired to a stubbed fetch",
        ],
      },
    ],
  },
];

/**
 * Build the AI "expand this into a starter" prompt for a chosen purpose. This
 * is what would be handed to the user's AI backend (currently stubbed in the UI).
 */
export function composePrompt(
  purpose: Purpose,
  projectName: string,
  templateName: string
): string {
  const bullets = purpose.starter.map((s) => `- ${s}`).join("\n");
  const name = projectName.trim() || "the project";
  return `You are expanding a freshly-scaffolded ${templateName} project named "${name}" into a STARTER for a ${purpose.name.toLowerCase()} — not a finished product.

Goal: ${purpose.goal}

Build a minimal but coherent starting point that includes:
${bullets}

Guidelines:
- Match the conventions and structure already present in the ${templateName} template.
- Keep it simple and readable so the user can build on it; do not over-engineer.
- Don't add features beyond the list above. Leave clear TODOs where the user should continue.`;
}
