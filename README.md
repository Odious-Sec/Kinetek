# Kinetek

> A local-first, visual **control center** for your projects — a friendly translator between your file system, GitHub, and VS Code.

Kinetek shows your projects as elegant cards with a **Plain English Summary**, a live **status**, and **framework tags** — clean enough for a non-technical person to understand at a glance, while giving you a one-click **bootstrapper** and **"Proceed to Code"** workflow.

Built with **Tauri v2 · React · TypeScript · Tailwind CSS**.

---

## ✨ Features (MVP)

- **Visual Project Dashboard** — searchable, filterable grid of project cards (summary, status, framework tags), with *Proceed to Code* / *Preview* / *reveal in Finder* actions.
- **New Project Wizard (the Bootstrapper)** — a guided, animated flow that picks a template, collects details, and runs the framework CLI in the background:
  - **React + Vite** → `npm create vite@latest <name> -- --template react-ts`
  - **React Native (Expo)** → `npx --yes create-expo-app@latest <name>`
  - **ASP.NET Core API** → `dotnet new webapi -o <name>`
  - **Node + Express** → scaffolded directly (works offline)
- **Proceed to Code** — opens any project in VS Code (`code /path/to/project`), with a macOS PATH-safe fallback.
- **Scan a Folder** — point Kinetek at a directory; it detects frameworks (React, Next.js, Vite, .NET, Rust/Tauri, Go, Python…) and turns each subfolder into a card.
- **Cross-platform** — all paths go through Rust's `PathBuf`; commands route through `cmd /C` on Windows and direct binaries / `open` / `xdg-open` elsewhere.

---

## 🏗 Architecture

```
Kinetek/
├── index.html                 # Vite entry
├── vite.config.ts             # Tauri-tuned dev server (port 1420)
├── tailwind.config.js         # Dark theme, animations
├── src/                       # ── Frontend (React + TS) ──
│   ├── main.tsx
│   ├── App.tsx                # State + handlers + toasts
│   ├── types.ts               # Shared domain types (mirror Rust structs)
│   ├── index.css              # Tailwind + native-feel tweaks
│   ├── lib/
│   │   ├── tauri.ts           # Typed wrapper around invoke() commands
│   │   ├── templates.ts       # Template catalog (ids match Rust)
│   │   └── sampleData.ts      # Seed cards for browser/dev
│   └── components/
│       ├── TitleBar.tsx       # Draggable overlay title bar
│       ├── Dashboard.tsx      # Grid, search, filters, empty state
│       ├── ProjectCard.tsx    # A single project card
│       ├── ProjectWizard.tsx  # Multi-step bootstrapper + loading states
│       ├── StatusBadge.tsx
│       ├── FrameworkTag.tsx
│       └── icons.tsx          # Inline SVG icon set
└── src-tauri/                 # ── Backend (Rust) ──
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json        # Window, security/CSP, bundle
    ├── capabilities/
    │   └── default.json       # Permissions: core, dialog, shell scopes
    └── src/
        ├── main.rs            # Thin binary → kinetek_lib::run()
        └── lib.rs             # Commands + cross-platform process logic
```

### Frontend ⇄ Backend contract

The frontend never calls `invoke` directly — everything goes through
[`src/lib/tauri.ts`](src/lib/tauri.ts), which maps to these Rust commands in
[`src-tauri/src/lib.rs`](src-tauri/src/lib.rs):

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `create_project`       | Run a template's CLI (off-thread) and return a card  |
| `scan_projects`        | Detect projects in a folder, one level deep          |
| `open_in_vscode`       | `code <path>` with a macOS `open -a` fallback        |
| `open_in_file_manager` | Reveal in Finder / Explorer / file browser           |

Long-running work (`create_project`, `scan_projects`) runs via
`tauri::async_runtime::spawn_blocking` so the UI never freezes.

---

## 🚀 Getting started

### Prerequisites

- **Node.js 18+** and **npm**
- **Rust** (stable) — install via [rustup](https://rustup.rs)
- Platform toolchains for Tauri v2:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Microsoft C++ Build Tools + WebView2 (preinstalled on Win 11)
  - **Linux**: `webkit2gtk-4.1`, `librsvg`, `libsoup-3.0`, etc. (see the
    [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- Optional, for the templates you intend to use: `dotnet` (for ASP.NET) and
  the `code` shell command (VS Code → Command Palette → *Shell Command: Install
  'code' command in PATH*).

### Install & run (this repo)

```bash
npm install          # frontend deps + @tauri-apps/cli
npm run tauri:dev    # launches Vite + the native window with hot reload
```

> The first `tauri:dev` compiles the Rust crate and downloads Tauri's native
> dependencies — expect a few minutes the first time, then it's fast.

### Build a distributable

```bash
npm run tauri:build  # produces a signed-ready .app/.dmg (macOS) or .msi/.exe (Windows)
```

### Regenerating the app icon

A source icon is generated programmatically (no design tools needed):

```bash
node scripts/generate-icon.cjs        # writes app-icon.png (1024×1024)
npx tauri icon app-icon.png           # fills src-tauri/icons/ for every platform
```

---

## 🧭 Scaffolding from scratch with the Tauri CLI

This repo is already wired up. If you ever want to recreate the skeleton from
zero, the canonical Tauri v2 path is:

```bash
# Interactive scaffolder — choose: TypeScript/JS → npm → React → TypeScript
npm create tauri-app@latest kinetek
cd kinetek
npm install

# Add the plugins Kinetek uses
npm run tauri add dialog
npm run tauri add shell

# Run it
npm run tauri dev
```

Then drop the `src/` and `src-tauri/src/` files from this repo over the
generated ones, and add the `shell`/`dialog` permissions shown in
[`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json).

---

## 🔐 Security model (Tauri v2)

Tauri v2 replaces the v1 allowlist with **capabilities + permissions**. Kinetek
keeps the surface area minimal:

- The heavy lifting (running CLIs, touching the filesystem) happens in **our own
  Rust commands**, which are gated by the IPC layer — *not* by the broad
  `fs`/`shell` plugin scopes — so there's no wide-open shell from JS.
- [`capabilities/default.json`](src-tauri/capabilities/default.json) grants:
  - `core:default` — baseline IPC/window/event permissions
  - `dialog:default` — the native folder picker
  - `shell:allow-open` + a **scoped** `shell:allow-execute` (only `code`, `npm`,
    `npx`, `dotnet`) — included to demonstrate scoped shell access; the app
    primarily uses the Rust commands above.
- A strict **CSP** is set in [`tauri.conf.json`](src-tauri/tauri.conf.json).

To widen or tighten access, edit the `permissions` array in the capability file.

---

## 🗺 Roadmap ideas

- Persist cards (summaries, status) to a local store (`tauri-plugin-store`).
- Embedded **dev-server preview** behind the *Preview* button.
- GitHub integration: repo status, open PRs, last commit per card.
- Drag-and-drop a folder onto the window to add it.
