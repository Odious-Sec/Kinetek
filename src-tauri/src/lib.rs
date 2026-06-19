//! Kinetek backend.
//!
//! All cross-platform process execution and filesystem work lives here and is
//! exposed to the React frontend as `#[tauri::command]`s. Design goals:
//!   * Never block the UI thread — long-running CLI work runs on a blocking
//!     thread pool via `spawn_blocking`.
//!   * Speak both macOS/Linux (`sh`-style direct binaries, `open`) and Windows
//!     (`cmd.exe`, `explorer`) without leaking platform details to the frontend.
//!   * Return human-readable error strings the UI can show verbatim.
//!   * Be safe: deletes go to the Trash, scaffolders never hang on a prompt.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

/// A project as rendered by a dashboard card. Serialized to camelCase so it
/// matches the TypeScript `Project` interface in `src/types.ts`.
/// The multi-part makeup of a project (app + optional API + optional database),
/// recorded at creation so the dashboard and the future DB view can use it.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStack {
    pub app: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub summary: String,
    pub status: String,
    pub frameworks: Vec<String>,
    #[serde(default)]
    pub has_preview: bool,
    /// Present for projects Kinetek assembled from app/API/database parts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<ProjectStack>,
}

/// The install/availability state of one tool a template needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prerequisite {
    /// Stable key, e.g. "node".
    pub key: String,
    /// Display name, e.g. "Node.js".
    pub name: String,
    /// Whether the template cannot be used without it.
    pub required: bool,
    pub installed: bool,
    pub version: Option<String>,
    /// Can Kinetek install it for the user via a package manager?
    pub auto_installable: bool,
    /// Human guidance / download URL for the manual case.
    pub install_hint: String,
    /// A URL the UI can open for manual installs (may be empty).
    pub url: String,
}

/// A file produced by the AI generation step, to be written into a project.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    /// Path relative to the project root (forward slashes, no `..`).
    pub path: String,
    pub contents: String,
}

/// One thing a preview needs in order to run (a runtime, SDK, or workload).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequirement {
    /// Stable key understood by `install_preview_requirement` (e.g. "dotnet",
    /// "node", "maui").
    pub key: String,
    pub name: String,
    pub satisfied: bool,
    /// Version when satisfied, or a hint about what's missing.
    pub detail: String,
    /// Kinetek can install it on this machine (a preview-only convenience).
    pub installable: bool,
    pub install_label: String,
    /// Manual-install URL (may be empty).
    pub url: String,
}

/// Whether/how a project can be previewed (run locally).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    pub previewable: bool,
    /// "web" | "static" | "dotnet" | "maui" | "unsupported" | "unknown".
    pub kind: String,
    /// "node" | "static" | "dotnet" | "none".
    pub runner: String,
    /// The npm script to run, if any (internal; harmless to the frontend).
    pub script: Option<String>,
    /// Node project missing its `node_modules`.
    pub needs_install: bool,
    /// Everything this preview needs, satisfied or not.
    pub requirements: Vec<PreviewRequirement>,
    /// All requirements satisfied (and deps installed) — ready to run.
    pub ready: bool,
    /// Friendly, plain-English explanation (esp. when not previewable).
    pub message: String,
    /// What the preview will actually do, e.g. "Builds and launches the app".
    pub how: String,
}

/// A started preview: the URL to load and the id used to stop it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    pub id: String,
    pub url: String,
}

/// Tracks running dev-server child processes so they can be stopped.
#[derive(Default)]
struct PreviewState(Mutex<HashMap<String, Child>>);

/// An in-app organizational folder (a virtual grouping — NOT a disk folder).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

/// Non-secret user preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_dir: Option<String>,
    /// "vscode" | "cursor" | "zed" | "finder".
    pub default_editor: String,
    /// AI provider id (see src/lib/ai.ts).
    pub ai_provider: String,
    /// Whether the first-run setup has been completed.
    #[serde(default)]
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_dir: None,
            default_editor: "vscode".into(),
            ai_provider: "gemini".into(),
            onboarded: false,
        }
    }
}

/// The user's whole persisted workspace: the project cards (with editable
/// metadata), organizational folders, assignments, and settings. Stored as
/// JSON in the app config dir. `serde(default)` on every field keeps older
/// files loadable as the shape grows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    #[serde(default)]
    pub projects: Vec<ProjectInfo>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    /// projectId (absolute path) -> folderId.
    #[serde(default)]
    pub assignments: HashMap<String, String>,
    #[serde(default)]
    pub settings: Settings,
}

/// One line of live output emitted to the frontend during a build.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputLine {
    line: String,
    /// "stdout" | "stderr".
    stream: String,
}

/// Read a child stream line-by-line: emit each line to the UI and collect it
/// (so a failure can report the captured output).
fn stream_and_collect<R: Read + Send + 'static>(
    app: tauri::AppHandle,
    reader: R,
    stream: &'static str,
    sink: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            let Ok(line) = line else { break };
            let _ = app.emit(
                "project-output",
                OutputLine {
                    line: line.clone(),
                    stream: stream.to_string(),
                },
            );
            if let Ok(mut v) = sink.lock() {
                v.push(line);
            }
        }
    })
}

/// How a given template materializes on disk.
enum Scaffold {
    /// Run an external CLI inside the parent directory; it creates `<name>/`.
    Cli {
        program: &'static str,
        args: Vec<String>,
    },
    /// We create the directory and write these (relative path, contents) files.
    Files(Vec<(&'static str, String)>),
}

// ---------------------------------------------------------------------------
// Cross-platform process helpers
// ---------------------------------------------------------------------------

/// Build a `Command` that runs `program args...` consistently across OSes.
///
/// On Windows, tools like `npm`/`npx`/`code` are batch shims (`*.cmd`) that
/// can't be spawned directly, so we route them through `cmd /C`. On Unix we
/// invoke the binary directly.
fn make_command(program: &str, args: &[String]) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args);
        cmd
    } else {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    }
}

/// Is `program` available on the PATH? (Runs `program <probe_args>`.)
fn tool_present(program: &str, probe_args: &[&str]) -> Option<String> {
    let args: Vec<String> = probe_args.iter().map(|s| s.to_string()).collect();
    let output = make_command(program, &args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Version may land on stdout or stderr depending on the tool.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    Some(line)
}

// ---------------------------------------------------------------------------
// Tool catalog (prerequisites)
// ---------------------------------------------------------------------------

struct ToolDef {
    key: &'static str,
    name: &'static str,
    /// Command used to detect/probe it (overridden per-OS where needed).
    command: &'static str,
    probe_args: &'static [&'static str],
    /// Homebrew formula (macOS auto-install), if any.
    brew: Option<&'static str>,
    /// winget package id (Windows auto-install), if any.
    winget: Option<&'static str>,
    /// Where to get it manually.
    url: &'static str,
    /// True for things we can never auto-install (IDEs/toolchains).
    manual_only: bool,
}

fn tool_catalog() -> &'static [ToolDef] {
    &[
        ToolDef {
            key: "node",
            name: "Node.js",
            command: "node",
            probe_args: &["--version"],
            brew: Some("node"),
            winget: Some("OpenJS.NodeJS.LTS"),
            url: "https://nodejs.org",
            manual_only: false,
        },
        ToolDef {
            key: "dotnet",
            name: ".NET SDK",
            command: "dotnet",
            probe_args: &["--version"],
            brew: Some("dotnet"),
            winget: Some("Microsoft.DotNet.SDK.8"),
            url: "https://dotnet.microsoft.com/download",
            manual_only: false,
        },
        ToolDef {
            key: "python",
            name: "Python 3",
            command: "python3",
            probe_args: &["--version"],
            brew: Some("python"),
            winget: Some("Python.Python.3.12"),
            url: "https://www.python.org/downloads/",
            manual_only: false,
        },
        ToolDef {
            key: "cargo",
            name: "Rust (cargo)",
            command: "cargo",
            probe_args: &["--version"],
            brew: Some("rust"),
            winget: Some("Rustlang.Rustup"),
            url: "https://rustup.rs",
            manual_only: false,
        },
        ToolDef {
            key: "go",
            name: "Go",
            command: "go",
            probe_args: &["version"],
            brew: Some("go"),
            winget: Some("GoLang.Go"),
            url: "https://go.dev/dl/",
            manual_only: false,
        },
        ToolDef {
            key: "claude",
            name: "Claude Code",
            command: "claude",
            probe_args: &["--version"],
            brew: None,
            winget: None,
            url: "https://docs.anthropic.com/en/docs/claude-code/setup",
            // Installed via `npm i -g @anthropic-ai/claude-code` or the native
            // installer — not via brew/winget, so we don't auto-install it.
            manual_only: true,
        },
        ToolDef {
            key: "android-studio",
            name: "Android Studio",
            command: "",
            probe_args: &[],
            brew: None,
            winget: None,
            url: "https://developer.android.com/studio",
            manual_only: true,
        },
        ToolDef {
            key: "xcode",
            name: "Xcode",
            command: "",
            probe_args: &[],
            brew: None,
            winget: None,
            url: "https://apps.apple.com/app/xcode/id497799835",
            manual_only: true,
        },
        ToolDef {
            key: "flutter",
            name: "Flutter SDK",
            command: "flutter",
            probe_args: &["--version"],
            brew: None,
            winget: None,
            url: "https://docs.flutter.dev/get-started/install",
            manual_only: true,
        },
    ]
}

fn find_tool(key: &str) -> Option<&'static ToolDef> {
    tool_catalog().iter().find(|t| t.key == key)
}

/// Which tools each template needs: `(tool_key, required)`.
fn template_prereqs(template_id: &str) -> Vec<(&'static str, bool)> {
    match template_id {
        // Node-based (Vite family, Next, Astro, Angular, Electron, Express, NestJS).
        "react-vite" | "vue-vite" | "svelte-vite" | "solid-vite" | "preact-vite"
        | "vanilla-vite" | "nextjs" | "astro" | "angular" | "node-express" | "nestjs"
        | "electron" => vec![("node", true)],
        "react-native" => {
            let mut v = vec![("node", true), ("android-studio", false)];
            // Xcode is only relevant (and detectable) on macOS.
            if cfg!(target_os = "macos") {
                v.push(("xcode", false));
            }
            v
        }
        // Tauri needs Node (frontend tooling) and Rust (the native shell).
        "tauri" => vec![("node", true), ("cargo", true)],
        "flutter" => vec![("flutter", true)],
        "maui" | "wpf" | "aspnet-core" => vec![("dotnet", true)],
        "python-fastapi" | "flask" => vec![("python", true)],
        "rust-cli" => vec![("cargo", true)],
        "go-module" => vec![("go", true)],
        "android-native" => vec![("android-studio", true)],
        "ios-native" | "macos-native" => {
            if cfg!(target_os = "macos") {
                vec![("xcode", true)]
            } else {
                vec![]
            }
        }
        "static-web" => vec![],
        _ => vec![],
    }
}

/// Path-based detection for tools without a CLI probe (IDEs).
fn special_installed(key: &str) -> Option<bool> {
    match key {
        "android-studio" => {
            if cfg!(target_os = "macos") {
                Some(Path::new("/Applications/Android Studio.app").exists())
            } else if cfg!(target_os = "windows") {
                let pf = std::env::var("ProgramFiles").unwrap_or_default();
                Some(Path::new(&pf).join("Android\\Android Studio").exists())
            } else {
                Some(Path::new("/opt/android-studio").exists())
            }
        }
        "xcode" => {
            if cfg!(target_os = "macos") {
                let by_path = Path::new("/Applications/Xcode.app").exists();
                let by_select = Command::new("xcode-select")
                    .arg("-p")
                    .stdin(Stdio::null())
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                Some(by_path || by_select)
            } else {
                Some(false)
            }
        }
        _ => None,
    }
}

fn check_one(key: &str, required: bool) -> Prerequisite {
    let def = match find_tool(key) {
        Some(d) => d,
        None => {
            return Prerequisite {
                key: key.to_string(),
                name: key.to_string(),
                required,
                installed: false,
                version: None,
                auto_installable: false,
                install_hint: "Unknown tool.".into(),
                url: String::new(),
            }
        }
    };

    // Detect: special path-based check, otherwise probe the command.
    let (installed, version) = if let Some(found) = special_installed(key) {
        (found, None)
    } else {
        // On Windows, Python's launcher is usually `python`, not `python3`.
        let command = if key == "python" && cfg!(target_os = "windows") {
            "python"
        } else {
            def.command
        };
        match tool_present(command, def.probe_args) {
            Some(v) => (true, Some(v)),
            None => (false, None),
        }
    };

    // Can we auto-install it on this platform?
    let auto_installable = !def.manual_only
        && ((cfg!(target_os = "macos") && def.brew.is_some())
            || (cfg!(target_os = "windows") && def.winget.is_some()));

    let install_hint = if def.manual_only {
        format!("Install {} directly from {}", def.name, def.url)
    } else if auto_installable {
        format!("Kinetek can install {} for you.", def.name)
    } else {
        format!("Install {} from {}", def.name, def.url)
    };

    Prerequisite {
        key: def.key.to_string(),
        name: def.name.to_string(),
        required,
        installed,
        version,
        auto_installable,
        install_hint,
        url: def.url.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/// Map a frontend template id to the work that creates it. Keep these ids in
/// sync with `src/lib/templates.ts`.
fn scaffold_for(template_id: &str, name: &str) -> Result<Scaffold, String> {
    let vite = |tmpl: &str| Scaffold::Cli {
        program: "npm",
        args: vec![
            "create".into(),
            "vite@latest".into(),
            name.into(),
            "--".into(),
            "--template".into(),
            tmpl.into(),
        ],
    };

    let scaffold = match template_id {
        // --- Web (Vite family + others) ---
        "react-vite" => vite("react-ts"),
        "vue-vite" => vite("vue-ts"),
        "svelte-vite" => vite("svelte-ts"),
        "solid-vite" => vite("solid-ts"),
        "preact-vite" => vite("preact-ts"),
        "vanilla-vite" => vite("vanilla-ts"),

        // npx --yes create-next-app@latest <name> <non-interactive flags>
        "nextjs" => Scaffold::Cli {
            program: "npx",
            args: vec![
                "--yes".into(),
                "create-next-app@latest".into(),
                name.into(),
                "--ts".into(),
                "--app".into(),
                "--eslint".into(),
                "--tailwind".into(),
                "--no-src-dir".into(),
                "--no-import-alias".into(),
                "--use-npm".into(),
            ],
        },

        // npm create astro@latest <name> -- <non-interactive flags>
        "astro" => Scaffold::Cli {
            program: "npm",
            args: vec![
                "create".into(),
                "astro@latest".into(),
                name.into(),
                "--".into(),
                "--template".into(),
                "minimal".into(),
                "--no-install".into(),
                "--no-git".into(),
                "--skip-houston".into(),
                "--yes".into(),
            ],
        },

        // npx --yes @angular/cli new <name> --defaults
        "angular" => Scaffold::Cli {
            program: "npx",
            args: vec![
                "--yes".into(),
                "@angular/cli@latest".into(),
                "new".into(),
                name.into(),
                "--defaults".into(),
                "--skip-install".into(),
                "--skip-git".into(),
            ],
        },

        // --- Mobile ---
        // npx --yes create-expo-app@latest <name>
        "react-native" => Scaffold::Cli {
            program: "npx",
            args: vec!["--yes".into(), "create-expo-app@latest".into(), name.into()],
        },
        // flutter create <name>
        "flutter" => Scaffold::Cli {
            program: "flutter",
            args: vec!["create".into(), name.into()],
        },
        // dotnet new maui -o <name> (cross-platform; needs the MAUI workload)
        "maui" => Scaffold::Cli {
            program: "dotnet",
            args: vec!["new".into(), "maui".into(), "-o".into(), name.into()],
        },
        "android-native" => Scaffold::Files(native_placeholder_files(name, "android")),
        "ios-native" => Scaffold::Files(native_placeholder_files(name, "ios")),
        "macos-native" => Scaffold::Files(native_placeholder_files(name, "macos")),

        // --- Desktop ---
        // npm create tauri-app@latest <name> -- <flags>
        "tauri" => Scaffold::Cli {
            program: "npm",
            args: vec![
                "create".into(),
                "tauri-app@latest".into(),
                name.into(),
                "--".into(),
                "--template".into(),
                "vanilla".into(),
                "--manager".into(),
                "npm".into(),
                "--yes".into(),
            ],
        },
        // npx --yes create-electron-app@latest <name>
        "electron" => Scaffold::Cli {
            program: "npx",
            args: vec!["--yes".into(), "create-electron-app@latest".into(), name.into()],
        },
        // dotnet new wpf -o <name> (Windows)
        "wpf" => Scaffold::Cli {
            program: "dotnet",
            args: vec!["new".into(), "wpf".into(), "-o".into(), name.into()],
        },

        // --- API ---
        // dotnet new webapi -o <name>
        "aspnet-core" => Scaffold::Cli {
            program: "dotnet",
            args: vec!["new".into(), "webapi".into(), "-o".into(), name.into()],
        },
        // npx --yes @nestjs/cli new <name> --package-manager npm --skip-git
        "nestjs" => Scaffold::Cli {
            program: "npx",
            args: vec![
                "--yes".into(),
                "@nestjs/cli@latest".into(),
                "new".into(),
                name.into(),
                "--package-manager".into(),
                "npm".into(),
                "--skip-git".into(),
            ],
        },

        // cargo new <name>
        "rust-cli" => Scaffold::Cli {
            program: "cargo",
            args: vec!["new".into(), name.into()],
        },

        // File-based templates (work offline, no required CLI to scaffold).
        "node-express" => Scaffold::Files(node_express_files(name)),
        "python-fastapi" => Scaffold::Files(python_fastapi_files(name)),
        "flask" => Scaffold::Files(flask_files(name)),
        "go-module" => Scaffold::Files(go_module_files(name)),
        "static-web" => Scaffold::Files(static_web_files(name)),

        other => return Err(format!("Unknown template: \"{other}\".")),
    };
    Ok(scaffold)
}

/// A guided starter for a true-native target (Android/iOS/macOS). We can't
/// generate a full native project from a CLI (those need Android Studio / Xcode),
/// so we lay down a folder + README that explains the next step.
fn native_placeholder_files(name: &str, platform: &str) -> Vec<(&'static str, String)> {
    let (ide, detail) = match platform {
        "android" => (
            "Android Studio",
            "Open Android Studio → New Project, and create it inside this folder (Kotlin / Jetpack Compose).",
        ),
        "ios" => (
            "Xcode",
            "Open Xcode → Create New Project → iOS App (Swift / SwiftUI), and save it inside this folder.",
        ),
        _ => (
            "Xcode",
            "Open Xcode → Create New Project → macOS App (Swift / SwiftUI), and save it inside this folder.",
        ),
    };
    vec![
        (
            "README.md",
            format!(
                "# {name}\n\nNative **{platform}** app starter.\n\nKinetek can't scaffold a full native {platform} project (that needs {ide}), so this folder is a placeholder.\n\n## Next step\n{detail}\n\nKinetek detects {ide} under the New Project prerequisites — install it from there if you don't have it yet.\n"
            ),
        ),
        (".gitkeep", String::new()),
    ]
}

/// Minimal Flask API starter (file-based, no CLI needed).
fn flask_files(name: &str) -> Vec<(&'static str, String)> {
    vec![
        (
            "app.py",
            "from flask import Flask, jsonify\n\napp = Flask(__name__)\n\n\n@app.get(\"/\")\ndef index():\n    return jsonify(message=\"Hello from Flask\")\n\n\nif __name__ == \"__main__\":\n    app.run(debug=True, port=5000)\n"
                .to_string(),
        ),
        ("requirements.txt", "flask>=3.0\n".to_string()),
        (
            "README.md",
            format!("# {name}\n\nFlask API.\n\n```bash\npython -m venv .venv && source .venv/bin/activate\npip install -r requirements.txt\npython app.py\n```\n"),
        ),
    ]
}

/// A representative starter for the chosen database engine. (Real provisioning
/// and the in-app data viewer come later — this lays down schema + connection
/// scaffolding so the shape is there.)
fn database_files(engine: &str) -> Vec<(&'static str, String)> {
    let e = engine.to_lowercase();
    let mut files: Vec<(&'static str, String)> = Vec::new();

    let (family, conn) = match e.as_str() {
        "postgresql" | "postgres" => ("SQL", "postgresql://user:password@localhost:5432/appdb"),
        "mysql" => ("SQL", "mysql://user:password@localhost:3306/appdb"),
        "sqlite" => ("SQL", "sqlite:./app.db"),
        "mongodb" | "mongo" => ("NoSQL", "mongodb://localhost:27017/appdb"),
        _ => ("SQL", "your-connection-string"),
    };

    files.push((
        "README.md",
        format!(
            "# Database — {engine}\n\nThis is a **{family}** database part, scaffolded by Kinetek.\n\n- `schema.*` — a starter schema you can grow.\n- `.env.example` — copy to `.env` and fill in real credentials.\n{}\n\n> An in-app **database viewer** (browse your data through Kinetek) is planned — this folder is the groundwork for it.\n",
            if e != "sqlite" && family != "NoSQL-skip" {
                "- `docker-compose.yml` — spin the database up locally with `docker compose up -d`."
            } else if e == "sqlite" {
                "- SQLite is file-based — no server needed."
            } else {
                ""
            }
        ),
    ));

    files.push((".env.example", format!("DATABASE_URL={conn}\n")));

    if family == "SQL" {
        files.push((
            "schema.sql",
            "-- Starter schema. Grow this as your app needs.\nCREATE TABLE users (\n    id          INTEGER PRIMARY KEY,\n    email       TEXT NOT NULL UNIQUE,\n    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n"
                .to_string(),
        ));
    } else {
        files.push((
            "schema.md",
            "# Collections\n\n## users\n```json\n{\n  \"_id\": \"ObjectId\",\n  \"email\": \"string (unique)\",\n  \"createdAt\": \"date\"\n}\n```\n"
                .to_string(),
        ));
    }

    // A docker-compose for server engines so the DB can actually be run later.
    let compose = match e.as_str() {
        "postgresql" | "postgres" => Some(
            "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: user\n      POSTGRES_PASSWORD: password\n      POSTGRES_DB: appdb\n    ports:\n      - \"5432:5432\"\n    volumes:\n      - dbdata:/var/lib/postgresql/data\nvolumes:\n  dbdata:\n",
        ),
        "mysql" => Some(
            "services:\n  db:\n    image: mysql:8\n    environment:\n      MYSQL_ROOT_PASSWORD: password\n      MYSQL_DATABASE: appdb\n      MYSQL_USER: user\n      MYSQL_PASSWORD: password\n    ports:\n      - \"3306:3306\"\n    volumes:\n      - dbdata:/var/lib/mysql\nvolumes:\n  dbdata:\n",
        ),
        "mongodb" | "mongo" => Some(
            "services:\n  db:\n    image: mongo:7\n    ports:\n      - \"27017:27017\"\n    volumes:\n      - dbdata:/data/db\nvolumes:\n  dbdata:\n",
        ),
        _ => None,
    };
    if let Some(c) = compose {
        files.push(("docker-compose.yml", c.to_string()));
    }

    files
}

fn node_express_files(name: &str) -> Vec<(&'static str, String)> {
    let package_json = format!(
        r#"{{
  "name": "{name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {{
    "start": "node index.js",
    "dev": "node --watch index.js"
  }},
  "dependencies": {{
    "express": "^4.19.2"
  }}
}}
"#
    );
    let index_js = r#"import express from "express";

const app = express();
const port = process.env.PORT ?? 3000;

app.get("/", (_req, res) => {
  res.json({ ok: true, message: "Hello from Kinetek 🚀" });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
"#
    .to_string();
    let readme = format!(
        "# {name}\n\nA Node + Express server scaffolded by Kinetek.\n\n```bash\nnpm install\nnpm run dev\n```\n"
    );
    vec![
        ("package.json", package_json),
        ("index.js", index_js),
        ("README.md", readme),
        (".gitignore", "node_modules\n.env\n".to_string()),
    ]
}

fn python_fastapi_files(name: &str) -> Vec<(&'static str, String)> {
    let main_py = r#"from fastapi import FastAPI

app = FastAPI(title="Kinetek API")


@app.get("/")
def read_root():
    return {"ok": True, "message": "Hello from Kinetek 🚀"}
"#
    .to_string();
    let requirements = "fastapi\nuvicorn[standard]\n".to_string();
    let readme = format!(
        "# {name}\n\nA FastAPI service scaffolded by Kinetek.\n\n```bash\npython3 -m venv .venv\nsource .venv/bin/activate   # Windows: .venv\\Scripts\\activate\npip install -r requirements.txt\nuvicorn main:app --reload\n```\n"
    );
    vec![
        ("main.py", main_py),
        ("requirements.txt", requirements),
        ("README.md", readme),
        (".gitignore", ".venv\n__pycache__\n".to_string()),
    ]
}

fn go_module_files(name: &str) -> Vec<(&'static str, String)> {
    let go_mod = format!("module {name}\n\ngo 1.22\n");
    let main_go = r#"package main

import "fmt"

func main() {
	fmt.Println("Hello from Kinetek 🚀")
}
"#
    .to_string();
    let readme = format!("# {name}\n\nA Go module scaffolded by Kinetek.\n\n```bash\ngo run .\n```\n");
    vec![
        ("go.mod", go_mod),
        ("main.go", main_go),
        ("README.md", readme),
    ]
}

fn static_web_files(name: &str) -> Vec<(&'static str, String)> {
    let index_html = format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{name}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>{name}</h1>
      <p>Hello from Kinetek 🚀</p>
    </main>
    <script src="main.js"></script>
  </body>
</html>
"#
    );
    let styles = r#":root { color-scheme: light dark; }
body {
  font-family: system-ui, sans-serif;
  display: grid;
  place-items: center;
  min-height: 100vh;
  margin: 0;
}
"#
    .to_string();
    let main_js = "console.log(\"Hello from Kinetek\");\n".to_string();
    let readme = format!(
        "# {name}\n\nA plain HTML/CSS/JS site scaffolded by Kinetek. Open `index.html` in a browser, or serve it:\n\n```bash\nnpx serve .\n```\n"
    );
    vec![
        ("index.html", index_html),
        ("styles.css", styles),
        ("main.js", main_js),
        ("README.md", readme),
    ]
}

// ---------------------------------------------------------------------------
// Framework detection (for scanning existing folders)
// ---------------------------------------------------------------------------

fn detect_frameworks(path: &Path) -> Vec<String> {
    let mut fw: Vec<String> = Vec::new();
    let push = |fw: &mut Vec<String>, label: &str| {
        if !fw.iter().any(|f| f == label) {
            fw.push(label.to_string());
        }
    };

    let pkg = path.join("package.json");
    if pkg.exists() {
        let content = fs::read_to_string(&pkg).unwrap_or_default();
        let has = |needle: &str| content.contains(needle);
        if has("\"next\"") {
            push(&mut fw, "Next.js");
        }
        if has("\"expo\"") || has("react-native") {
            push(&mut fw, "React Native");
        }
        if has("\"react\"") {
            push(&mut fw, "React");
        }
        if has("\"vue\"") {
            push(&mut fw, "Vue");
        }
        if has("\"svelte\"") {
            push(&mut fw, "Svelte");
        }
        if has("\"vite\"") {
            push(&mut fw, "Vite");
        }
        if has("\"express\"") {
            push(&mut fw, "Express");
        }
        if has("\"typescript\"") {
            push(&mut fw, "TypeScript");
        }
        if fw.is_empty() {
            push(&mut fw, "Node.js");
        }
    }

    if path.join("Cargo.toml").exists() {
        push(&mut fw, "Rust");
    }
    if path.join("src-tauri").exists() {
        push(&mut fw, "Tauri");
    }
    if path.join("requirements.txt").exists() || path.join("pyproject.toml").exists() {
        push(&mut fw, "Python");
    }
    if path.join("go.mod").exists() {
        push(&mut fw, "Go");
    }

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            match p.extension().and_then(|e| e.to_str()) {
                Some("csproj") | Some("sln") => {
                    push(&mut fw, ".NET");
                    break;
                }
                _ => {}
            }
        }
    }

    fw
}

// ---------------------------------------------------------------------------
// Core (sync) implementations — run on a blocking thread.
// ---------------------------------------------------------------------------

/// Run one scaffold into `run_dir`, creating a subfolder named `folder`
/// (CLI tools create it themselves; file-based ones write into `run_dir/folder`).
/// Output streams live via `project-output`.
fn apply_scaffold(
    app: &tauri::AppHandle,
    scaffold: Scaffold,
    run_dir: &Path,
    folder: &str,
) -> Result<(), String> {
    match scaffold {
        Scaffold::Cli { program, args } => {
            let _ = app.emit(
                "project-output",
                OutputLine {
                    line: format!("$ {} {}", program, args.join(" ")),
                    stream: "stdout".into(),
                },
            );
            // CI=1 + a null stdin keep scaffolders non-interactive.
            let mut child = make_command(program, &args)
                .current_dir(run_dir)
                .env("CI", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| {
                    format!("Could not run `{program}`: {e}\n\nMake sure {program} is installed and available on your PATH.")
                })?;

            let collected = Arc::new(Mutex::new(Vec::<String>::new()));
            let mut handles = Vec::new();
            if let Some(out) = child.stdout.take() {
                handles.push(stream_and_collect(app.clone(), out, "stdout", collected.clone()));
            }
            if let Some(err) = child.stderr.take() {
                handles.push(stream_and_collect(app.clone(), err, "stderr", collected.clone()));
            }
            let exit = child
                .wait()
                .map_err(|e| format!("`{program}` failed while running: {e}"))?;
            for h in handles {
                let _ = h.join();
            }
            if !exit.success() {
                let detail = collected.lock().map(|v| v.join("\n")).unwrap_or_default();
                let detail = detail.trim();
                return Err(format!(
                    "`{program}` exited with an error:\n\n{}",
                    if detail.is_empty() { "(no output)" } else { detail }
                ));
            }
            Ok(())
        }
        Scaffold::Files(files) => {
            let base = run_dir.join(folder);
            write_files(app, &base, files)
        }
    }
}

/// Write a (relative path, contents) file set into `base`, streaming progress.
fn write_files(
    app: &tauri::AppHandle,
    base: &Path,
    files: Vec<(&'static str, String)>,
) -> Result<(), String> {
    fs::create_dir_all(base)
        .map_err(|e| format!("Could not create {}: {e}", base.display()))?;
    for (rel, contents) in files {
        let target = base.join(rel);
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        fs::write(&target, contents)
            .map_err(|e| format!("Could not write {}: {e}", target.display()))?;
        let _ = app.emit(
            "project-output",
            OutputLine {
                line: format!("Created {}/{rel}", base.file_name().and_then(|n| n.to_str()).unwrap_or("")),
                stream: "stdout".into(),
            },
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_project_inner(
    app: tauri::AppHandle,
    parent_dir: String,
    project_name: String,
    app_template_id: String,
    api_template_id: Option<String>,
    database_engine: Option<String>,
    summary: String,
    status: String,
    frameworks: Vec<String>,
) -> Result<ProjectInfo, String> {
    let name = project_name.trim();
    if name.is_empty() {
        return Err("Project name cannot be empty.".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Project name may not contain path separators.".into());
    }

    let parent = PathBuf::from(&parent_dir);
    if !parent.is_dir() {
        return Err(format!(
            "The location \"{}\" is not an existing folder.",
            parent.display()
        ));
    }

    let api_id = api_template_id.filter(|s| !s.trim().is_empty());
    let db_engine = database_engine.filter(|s| !s.trim().is_empty());
    let monorepo = api_id.is_some() || db_engine.is_some();

    let project_path = parent.join(name);
    if project_path.exists() {
        return Err(format!(
            "A folder named \"{name}\" already exists at that location."
        ));
    }

    let stack = ProjectStack {
        app: app_template_id.clone(),
        api: api_id.clone(),
        database: db_engine.clone(),
    };

    if !monorepo {
        // Simple project: scaffold the app directly at parent/<name>.
        apply_scaffold(&app, scaffold_for(&app_template_id, name)?, &parent, name)?;
    } else {
        // Monorepo: <name>/app, <name>/api, <name>/database under one folder.
        fs::create_dir_all(&project_path)
            .map_err(|e| format!("Could not create the project folder: {e}"))?;

        let _ = app.emit(
            "project-output",
            OutputLine { line: "— Creating app —".into(), stream: "stdout".into() },
        );
        apply_scaffold(&app, scaffold_for(&app_template_id, "app")?, &project_path, "app")?;

        if let Some(api) = &api_id {
            let _ = app.emit(
                "project-output",
                OutputLine { line: "— Creating API —".into(), stream: "stdout".into() },
            );
            apply_scaffold(&app, scaffold_for(api, "api")?, &project_path, "api")?;
        }

        if let Some(engine) = &db_engine {
            let _ = app.emit(
                "project-output",
                OutputLine { line: "— Creating database —".into(), stream: "stdout".into() },
            );
            write_files(&app, &project_path.join("database"), database_files(engine))?;
        }

        // A root README describing the assembled parts.
        let mut readme = format!("# {name}\n\nCreated with Kinetek.\n\n## Structure\n- `app/` — application\n");
        if api_id.is_some() {
            readme.push_str("- `api/` — API service\n");
        }
        if let Some(engine) = &db_engine {
            readme.push_str(&format!("- `database/` — {engine} (schema + setup)\n"));
        }
        let _ = fs::write(project_path.join("README.md"), readme);
    }

    Ok(ProjectInfo {
        id: project_path.to_string_lossy().to_string(),
        name: name.to_string(),
        path: project_path.to_string_lossy().to_string(),
        summary,
        status,
        frameworks,
        has_preview: true,
        stack: Some(stack),
    })
}

fn scan_projects_inner(dir: String) -> Result<Vec<ProjectInfo>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!(
            "The location \"{}\" is not an existing folder.",
            root.display()
        ));
    }

    let entries = fs::read_dir(&root)
        .map_err(|e| format!("Could not read \"{}\": {e}", root.display()))?;

    let mut projects: Vec<ProjectInfo> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }

        let frameworks = detect_frameworks(&path);
        if frameworks.is_empty() {
            continue;
        }

        projects.push(ProjectInfo {
            id: path.to_string_lossy().to_string(),
            name,
            path: path.to_string_lossy().to_string(),
            summary: String::new(),
            status: "In Development".into(),
            frameworks,
            has_preview: path.join("package.json").exists(),
            stack: None,
        });
    }

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

/// Refuse obviously dangerous delete targets (root, home, very shallow paths).
fn guard_deletable(p: &Path) -> Result<(), String> {
    if p.components().count() < 3 {
        return Err("Refusing to delete a top-level system path.".into());
    }
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(var) {
            if !home.is_empty() && Path::new(&home) == p {
                return Err("Refusing to delete your home folder.".into());
            }
        }
    }
    Ok(())
}

fn install_tool_inner(key: String) -> Result<(), String> {
    let def = find_tool(&key).ok_or_else(|| format!("Unknown tool: \"{key}\"."))?;
    if def.manual_only {
        return Err(format!(
            "{} can't be installed automatically. Please install it from {}.",
            def.name, def.url
        ));
    }

    if cfg!(target_os = "macos") {
        let formula = def
            .brew
            .ok_or_else(|| format!("No Homebrew package is configured for {}.", def.name))?;
        let brew = resolve_brew().ok_or_else(|| {
            "Homebrew isn't installed, so Kinetek can't auto-install this. Get it from https://brew.sh and try again.".to_string()
        })?;
        let output = Command::new(brew)
            .arg("install")
            .arg(formula)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Could not run Homebrew: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("`brew install {formula}` failed:\n\n{}", stderr.trim()));
        }
        Ok(())
    } else if cfg!(target_os = "windows") {
        let id = def
            .winget
            .ok_or_else(|| format!("No winget package is configured for {}.", def.name))?;
        let args: Vec<String> = vec![
            "install".into(),
            "--id".into(),
            id.into(),
            "-e".into(),
            "--accept-package-agreements".into(),
            "--accept-source-agreements".into(),
        ];
        let output = make_command("winget", &args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| {
                format!("Could not run winget: {e}\n\nInstall {} from {} instead.", def.name, def.url)
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if stderr.trim().is_empty() { stdout } else { stderr };
            return Err(format!("winget could not install {}:\n\n{}", def.name, detail.trim()));
        }
        Ok(())
    } else {
        Err(format!(
            "Automatic install isn't supported on Linux yet. Please install {} via your package manager ({}).",
            def.name, def.url
        ))
    }
}

/// Resolve the `brew` executable, falling back to the common install paths a
/// Finder-launched app won't have on its PATH.
fn resolve_brew() -> Option<String> {
    if tool_present("brew", &["--version"]).is_some() {
        return Some("brew".to_string());
    }
    for candidate in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Preview (run a project locally)
// ---------------------------------------------------------------------------

/// Decide whether/how a project can be previewed.
/// Build a preview requirement from the shared tool catalog (node/dotnet/…).
fn tool_requirement(key: &str) -> PreviewRequirement {
    let pre = check_one(key, true);
    let detail = if pre.installed {
        pre.version.clone().unwrap_or_else(|| "Installed".into())
    } else {
        pre.install_hint.clone()
    };
    PreviewRequirement {
        key: pre.key,
        name: pre.name.clone(),
        satisfied: pre.installed,
        detail,
        installable: pre.auto_installable && !pre.installed,
        install_label: format!("Install {}", pre.name),
        url: pre.url,
    }
}

/// Is a given .NET SDK workload (e.g. "maui") installed?
fn dotnet_workload_present(name: &str) -> bool {
    Command::new("dotnet")
        .args(["workload", "list"])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_lowercase()
                .contains(&name.to_lowercase())
        })
        .unwrap_or(false)
}

/// Find a .NET project/solution in `path` and whether it looks like a MAUI app.
fn find_dotnet(path: &Path) -> Option<(PathBuf, bool)> {
    let mut csproj: Option<PathBuf> = None;
    let mut sln: Option<PathBuf> = None;
    for entry in fs::read_dir(path).ok()?.flatten() {
        let p = entry.path();
        match p.extension().and_then(|e| e.to_str()) {
            Some("csproj") if csproj.is_none() => csproj = Some(p),
            Some("sln") if sln.is_none() => sln = Some(p),
            _ => {}
        }
    }
    let chosen = csproj.clone().or(sln)?;
    // Heuristic MAUI detection from the .csproj contents.
    let is_maui = csproj
        .map(|c| {
            let body = fs::read_to_string(&c).unwrap_or_default().to_lowercase();
            body.contains("usemaui")
                || body.contains("microsoft.maui")
                || body.contains("-android")
                || body.contains("-ios")
                || body.contains("-maccatalyst")
        })
        .unwrap_or(false);
    Some((chosen, is_maui))
}

fn preview_plan(path: &Path) -> PreviewStatus {
    let pkg = path.join("package.json");
    if pkg.exists() {
        let content = fs::read_to_string(&pkg).unwrap_or_default();
        let script = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| {
                v.get("scripts")
                    .and_then(|s| s.as_object())
                    .and_then(|o| {
                        ["dev", "start", "serve"]
                            .iter()
                            .find(|k| o.contains_key(**k))
                            .map(|k| k.to_string())
                    })
            });

        return match script {
            Some(s) => {
                let node = tool_requirement("node");
                let needs_install = !path.join("node_modules").exists();
                let ready = node.satisfied && !needs_install;
                PreviewStatus {
                    previewable: true,
                    kind: "web".into(),
                    runner: "node".into(),
                    script: Some(s),
                    needs_install,
                    requirements: vec![node],
                    ready,
                    message: String::new(),
                    how: "Runs the dev server and opens it in a Kinetek window.".into(),
                }
            }
            None => PreviewStatus {
                previewable: false,
                kind: "unsupported".into(),
                runner: "none".into(),
                script: None,
                needs_install: false,
                requirements: vec![],
                ready: false,
                message: "This Node project has no \"dev\", \"start\" or \"serve\" script to preview. Add one to its package.json, then try again.".into(),
                how: String::new(),
            },
        };
    }

    if path.join("index.html").exists() {
        return PreviewStatus {
            previewable: true,
            kind: "static".into(),
            runner: "static".into(),
            script: None,
            needs_install: false,
            requirements: vec![],
            ready: true,
            message: String::new(),
            how: "Opens the page in a Kinetek window.".into(),
        };
    }

    // .NET (incl. MAUI): build & launch the app.
    if let Some((_, is_maui)) = find_dotnet(path) {
        let dotnet = tool_requirement("dotnet");
        let dotnet_ok = dotnet.satisfied;
        let mut requirements = vec![dotnet];
        if is_maui {
            let present = dotnet_ok && dotnet_workload_present("maui");
            requirements.push(PreviewRequirement {
                key: "maui".into(),
                name: ".NET MAUI workload".into(),
                satisfied: present,
                detail: if present {
                    "Installed".into()
                } else if dotnet_ok {
                    "Needed to build MAUI apps — Kinetek can install it.".into()
                } else {
                    "Requires the .NET SDK first.".into()
                },
                // Only installable once the SDK exists (we install via `dotnet`).
                installable: dotnet_ok && !present,
                install_label: "Install MAUI workload".into(),
                url: "https://learn.microsoft.com/dotnet/maui/get-started/installation".into(),
            });
        }
        let ready = requirements.iter().all(|r| r.satisfied);
        return PreviewStatus {
            previewable: true,
            kind: if is_maui { "maui".into() } else { "dotnet".into() },
            runner: "dotnet".into(),
            script: None,
            needs_install: false,
            requirements,
            ready,
            message: String::new(),
            how: if is_maui {
                "Builds the MAUI app and launches it (opens in its own window).".into()
            } else {
                "Builds the project and runs it.".into()
            },
        };
    }

    PreviewStatus {
        previewable: false,
        kind: "unsupported".into(),
        runner: "none".into(),
        script: None,
        needs_install: false,
        requirements: vec![],
        ready: false,
        message: "Preview can run web projects (a Node dev server or static site) and .NET apps. This project type isn't supported yet — open it in your editor to run it.".into(),
        how: String::new(),
    }
}

/// Pull the first local dev-server URL out of a log line (handles ANSI color).
fn extract_local_url(line: &str) -> Option<String> {
    for marker in [
        "http://localhost:",
        "http://127.0.0.1:",
        "https://localhost:",
    ] {
        if let Some(idx) = line.find(marker) {
            let tail = &line[idx..];
            let end = tail
                .find(|c: char| c.is_whitespace() || c.is_control())
                .unwrap_or(tail.len());
            return Some(tail[..end].to_string());
        }
    }
    None
}

/// Drain a child stream line-by-line, sending any dev-server URL it prints.
fn spawn_url_reader<R: Read + Send + 'static>(reader: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            let Ok(line) = line else { break };
            if let Some(url) = extract_local_url(&line) {
                let _ = tx.send(url);
            }
        }
    });
}

/// Kill a dev server and its children. On Unix the child is its own process
/// group leader, so we signal the whole group (otherwise the real server,
/// spawned by `npm`, would be orphaned and keep holding its port).
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Separates the friendly preview error from the raw developer detail so the
/// frontend can show one in plain English and the other behind a "details"
/// toggle. (Chosen to never collide with normal compiler output.)
const PREVIEW_DEV_SEP: &str = "||KINETEK_DEV||";

/// Pack a friendly message + raw output into a single error string.
fn preview_error(friendly: &str, raw: &str) -> String {
    let raw = raw.trim();
    // Cap the dev detail so a giant build log doesn't bloat the payload.
    let tail: String = if raw.chars().count() > 6000 {
        let skip = raw.chars().count() - 6000;
        raw.chars().skip(skip).collect()
    } else {
        raw.to_string()
    };
    if tail.is_empty() {
        friendly.to_string()
    } else {
        format!("{friendly}{PREVIEW_DEV_SEP}{tail}")
    }
}

/// Turn raw `dotnet` build output into a plain-English reason.
fn classify_dotnet_failure(raw: &str, is_maui: bool) -> String {
    let l = raw.to_lowercase();
    if l.contains("workload") && (l.contains("not installed") || l.contains("maui") || l.contains("missing")) {
        return "This project needs the .NET MAUI workload. Install it above, then run the preview again.".into();
    }
    if is_maui && (l.contains("--framework") || l.contains("specify a") || l.contains("targetframework")) {
        return "This MAUI app needs a specific target platform to run, or targets an older setup — it likely needs attention before it can be displayed.".into();
    }
    if l.contains("netsdk") || l.contains("does not support targeting") || l.contains("downgrade") || (l.contains("sdk") && l.contains("not found")) {
        return "This app targets a .NET version your machine doesn't have — it looks like an older project that needs updating before it can run.".into();
    }
    if l.contains("error") || l.contains("msb") {
        return "The project didn't build — it may be old and need attention before it can be previewed. See developer details for the exact errors.".into();
    }
    "The preview couldn't complete. Open developer details to see the exact error.".into()
}

/// Build a .NET project and, on success, launch it (it opens in its own window).
/// On failure returns a friendly+raw error so the UI can show both.
fn start_dotnet_preview(
    path: &Path,
    is_maui: bool,
    id: String,
) -> Result<(String, String, Option<Child>), String> {
    if tool_present("dotnet", &["--version"]).is_none() {
        return Err("The .NET SDK is required to preview this project.".into());
    }

    // Build first (bounded) so broken/old projects fail with a real reason.
    let build = make_command("dotnet", &["build".to_string(), "-nologo".to_string()])
        .current_dir(path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not run dotnet: {e}. Is the .NET SDK on your PATH?"))?;
    if !build.status.success() {
        let raw = format!(
            "{}{}",
            String::from_utf8_lossy(&build.stdout),
            String::from_utf8_lossy(&build.stderr)
        );
        return Err(preview_error(&classify_dotnet_failure(&raw, is_maui), &raw));
    }

    // Built cleanly → launch it detached. The app surfaces in its own window;
    // a clean build is our "it works" signal.
    let mut run = make_command("dotnet", &["run".to_string(), "--no-build".to_string()]);
    run.current_dir(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        run.process_group(0);
    }
    let child = run.spawn().ok();
    Ok((id, String::new(), child))
}

/// Start the dev server (or resolve a static URL). Returns the preview id, the
/// URL to load (empty for native apps), and the child process to track.
fn start_preview_inner(
    project_path: String,
) -> Result<(String, String, Option<Child>), String> {
    let path = PathBuf::from(&project_path);
    if !path.is_dir() {
        return Err(format!("The path \"{}\" no longer exists.", path.display()));
    }

    let plan = preview_plan(&path);
    if !plan.previewable {
        return Err(plan.message);
    }

    let id = format!(
        "{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    if plan.runner == "static" {
        let index = path.join("index.html");
        let url = format!("file://{}", index.to_string_lossy());
        return Ok((id, url, None));
    }

    // .NET (incl. MAUI): build, then launch the app in its own window.
    if plan.runner == "dotnet" {
        return start_dotnet_preview(&path, plan.kind == "maui", id);
    }

    // Node dev server.
    if tool_present("node", &["--version"]).is_none() {
        return Err("Node.js is required to preview this project.".into());
    }
    let script = plan
        .script
        .ok_or_else(|| "No dev script to run.".to_string())?;

    let mut cmd = make_command("npm", &["run".to_string(), script]);
    cmd.current_dir(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("BROWSER", "none") // don't auto-open a browser
        .env("FORCE_COLOR", "0"); // keep URL lines clean
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("Could not start the dev server: {e}. Is npm installed and on your PATH?")
    })?;

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(out) = child.stdout.take() {
        spawn_url_reader(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        spawn_url_reader(err, tx.clone());
    }
    drop(tx); // only the reader threads hold senders now

    match rx.recv_timeout(Duration::from_secs(90)) {
        Ok(url) => Ok((id, url, Some(child))),
        Err(_) => {
            kill_tree(&mut child);
            Err("Timed out waiting for the dev server to start. Make sure the project runs with its dev/start script.".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (the frontend-facing API)
// ---------------------------------------------------------------------------

/// Bootstrap a new project: an app, plus an optional API and database, assembled
/// into one project folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn create_project(
    app: tauri::AppHandle,
    parent_dir: String,
    project_name: String,
    app_template_id: String,
    api_template_id: Option<String>,
    database_engine: Option<String>,
    summary: String,
    status: String,
    frameworks: Vec<String>,
) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_project_inner(
            app,
            parent_dir,
            project_name,
            app_template_id,
            api_template_id,
            database_engine,
            summary,
            status,
            frameworks,
        )
    })
    .await
    .map_err(|e| format!("The bootstrapping task failed unexpectedly: {e}"))?
}

/// Scan a folder one level deep and return recognized projects.
#[tauri::command]
async fn scan_projects(dir: String) -> Result<Vec<ProjectInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_projects_inner(dir))
        .await
        .map_err(|e| format!("The scan task failed unexpectedly: {e}"))?
}

/// Check whether the tools a template needs are installed.
#[tauri::command]
async fn check_prerequisites(template_id: String) -> Result<Vec<Prerequisite>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        template_prereqs(&template_id)
            .into_iter()
            .map(|(key, required)| check_one(key, required))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("The prerequisite check failed unexpectedly: {e}"))
}

/// Install a tool for the user via the platform package manager.
#[tauri::command]
async fn install_tool(tool_key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_tool_inner(tool_key))
        .await
        .map_err(|e| format!("The install task failed unexpectedly: {e}"))?
}

/// Move a project folder to the system Trash / Recycle Bin (recoverable).
#[tauri::command]
async fn delete_project(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("The path \"{}\" no longer exists.", p.display()));
        }
        guard_deletable(&p)?;
        move_to_trash(&p)
    })
    .await
    .map_err(|e| format!("The delete task failed unexpectedly: {e}"))?
}

/// Permanently delete a project folder (NOT recoverable). Used as a fallback
/// when "move to Trash" fails — e.g. iCloud-evicted items that Finder refuses
/// to trash. Unlinking a placeholder doesn't require downloading it, so this
/// succeeds where Trash won't.
#[tauri::command]
async fn delete_project_permanently(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("The path \"{}\" no longer exists.", p.display()));
        }
        guard_deletable(&p)?;
        if p.is_dir() {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        }
        .map_err(|e| format!("Could not delete \"{}\": {e}", p.display()))
    })
    .await
    .map_err(|e| format!("The delete task failed unexpectedly: {e}"))?
}

/// Move a path to the Trash, preferring `NSFileManager` on macOS over the
/// Finder/AppleScript method (which errors on iCloud-evicted items and may
/// prompt for automation permission).
fn move_to_trash(p: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        return ctx
            .delete(p)
            .map_err(|e| format!("Could not move to Trash: {e}"));
    }
    #[allow(unreachable_code)]
    {
        trash::delete(p).map_err(|e| format!("Could not move to Trash: {e}"))
    }
}

/// Report whether (and how) a project can be previewed.
#[tauri::command]
async fn preview_status(project_path: String) -> Result<PreviewStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&project_path);
        if !path.is_dir() {
            return PreviewStatus {
                previewable: false,
                kind: "unknown".into(),
                runner: "none".into(),
                script: None,
                needs_install: false,
                requirements: vec![],
                ready: false,
                message: "That folder no longer exists.".into(),
                how: String::new(),
            };
        }
        preview_plan(&path)
    })
    .await
    .map_err(|e| format!("The preview check failed unexpectedly: {e}"))
}

/// Install a Node project's dependencies (`npm install`).
#[tauri::command]
async fn install_deps(project_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&project_path);
        if !path.is_dir() {
            return Err(format!("The path \"{}\" no longer exists.", path.display()));
        }
        let output = make_command("npm", &["install".to_string()])
            .current_dir(&path)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Could not run npm install: {e}. Is npm on your PATH?"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm install failed:\n\n{}", stderr.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("The install task failed unexpectedly: {e}"))?
}

/// Install a single preview requirement (preview-only convenience). Handles the
/// shared tools (node/dotnet via the package manager) and the .NET MAUI workload
/// (`dotnet workload install maui`). Errors carry friendly + raw detail.
#[tauri::command]
async fn install_preview_requirement(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_preview_requirement_inner(key))
        .await
        .map_err(|e| format!("The install task failed unexpectedly: {e}"))?
}

fn install_preview_requirement_inner(key: String) -> Result<(), String> {
    match key.as_str() {
        "node" | "dotnet" => install_tool_inner(key.clone())
            .map_err(|raw| preview_error(&format!("Couldn't install {key} automatically."), &raw)),
        "maui" => {
            if tool_present("dotnet", &["--version"]).is_none() {
                return Err(preview_error(
                    "Install the .NET SDK first, then the MAUI workload.",
                    "dotnet was not found on your PATH.",
                ));
            }
            let out = make_command(
                "dotnet",
                &["workload".to_string(), "install".to_string(), "maui".to_string()],
            )
            .stdin(Stdio::null())
            .output()
            .map_err(|e| {
                preview_error("Could not run dotnet to install the MAUI workload.", &e.to_string())
            })?;
            if out.status.success() {
                return Ok(());
            }
            let raw = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let l = raw.to_lowercase();
            let friendly = if l.contains("permission")
                || l.contains("denied")
                || l.contains("administrator")
                || l.contains("elevated")
                || l.contains("sudo")
            {
                "Installing the MAUI workload needs elevated permissions. Run `dotnet workload install maui` in a terminal (with sudo / as admin), then come back."
            } else {
                "Couldn't install the .NET MAUI workload automatically."
            };
            Err(preview_error(friendly, &raw))
        }
        other => Err(format!("Don't know how to install \"{other}\" for preview.")),
    }
}

/// Start a preview (dev server or static site) and return its URL + id.
#[tauri::command]
async fn start_preview(
    state: State<'_, PreviewState>,
    project_path: String,
) -> Result<PreviewInfo, String> {
    let (id, url, child) =
        tauri::async_runtime::spawn_blocking(move || start_preview_inner(project_path))
            .await
            .map_err(|e| format!("The preview task failed unexpectedly: {e}"))??;

    if let Some(child) = child {
        state.0.lock().unwrap().insert(id.clone(), child);
    }
    Ok(PreviewInfo { id, url })
}

/// Stop a running preview (kills its dev server, if any).
#[tauri::command]
fn stop_preview(state: State<'_, PreviewState>, id: String) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().unwrap().remove(&id) {
        kill_tree(&mut child);
    }
    Ok(())
}

/// Path to the organization JSON file in the app config dir.
fn organization_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve the app config directory: {e}"))?;
    Ok(dir.join("organization.json"))
}

/// Load the saved project organization (folders + assignments).
#[tauri::command]
fn load_organization(app: tauri::AppHandle) -> Result<Organization, String> {
    let path = organization_path(&app)?;
    if !path.exists() {
        return Ok(Organization::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Could not read organization: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Could not parse the organization file: {e}"))
}

/// Persist the project organization.
#[tauri::command]
fn save_organization(app: tauri::AppHandle, organization: Organization) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve the app config directory: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the app config directory: {e}"))?;
    let json = serde_json::to_string_pretty(&organization)
        .map_err(|e| format!("Could not serialize organization: {e}"))?;
    fs::write(dir.join("organization.json"), json)
        .map_err(|e| format!("Could not write organization: {e}"))?;
    Ok(())
}

// --- Secrets (OS keychain) -------------------------------------------------

/// Store a secret (e.g. an AI API key) in the OS keychain.
#[tauri::command]
fn set_secret(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new("Kinetek", &key).map_err(|e| e.to_string())?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Could not save to the keychain: {e}"))
}

/// Read a secret from the OS keychain (None if not set).
#[tauri::command]
fn get_secret(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("Kinetek", &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the keychain: {e}")),
    }
}

/// Delete a secret from the OS keychain (no-op if absent).
#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new("Kinetek", &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete from the keychain: {e}")),
    }
}

// --- Project context (for AI "Explain this project") -----------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub name: String,
    pub readme: Option<String>,
    pub package_json: Option<String>,
}

fn truncate(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        s
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push_str("\n…(truncated)");
        out
    }
}

/// Read a small amount of context from a project (README + package.json) so the
/// AI can summarize it. Large files are truncated.
#[tauri::command]
async fn read_project_context(project_path: String) -> Result<ProjectContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&project_path);
        if !path.is_dir() {
            return Err(format!("The path \"{}\" no longer exists.", path.display()));
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".into());

        let readme = ["README.md", "README.MD", "Readme.md", "readme.md", "README.txt", "README"]
            .iter()
            .find_map(|f| fs::read_to_string(path.join(f)).ok())
            .map(|s| truncate(s, 6000));

        let package_json = fs::read_to_string(path.join("package.json"))
            .ok()
            .map(|s| truncate(s, 4000));

        Ok(ProjectContext {
            name,
            readme,
            package_json,
        })
    })
    .await
    .map_err(|e| format!("Reading the project failed unexpectedly: {e}"))?
}

// --- Git status ------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit: Option<String>,
    pub last_commit_relative: Option<String>,
}

/// Report local git status for a project, or None if it isn't a git repo.
#[tauri::command]
async fn git_status(project_path: String) -> Result<Option<GitStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&project_path);
        if !path.join(".git").exists() {
            return Ok(None);
        }

        let run = |args: &[&str]| -> Option<String> {
            let out = Command::new("git")
                .args(args)
                .current_dir(&path)
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        };

        let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "HEAD".into());
        let dirty = run(&["status", "--porcelain"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);

        // "<ahead> <behind>" relative to the upstream if one is configured.
        // When the branch has no upstream tracking (common right after a push
        // through Kinetek, which doesn't set tracking refs), fall back to
        // comparing against `origin/<branch>` so unpushed commits still show.
        let parse_counts = |s: String| {
            let mut it = s.split_whitespace();
            let a = it.next().and_then(|x| x.parse().ok()).unwrap_or(0u32);
            let b = it.next().and_then(|x| x.parse().ok()).unwrap_or(0u32);
            (a, b)
        };
        let (ahead, behind) = run(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])
            .or_else(|| {
                let range = format!("HEAD...origin/{branch}");
                run(&["rev-list", "--left-right", "--count", &range])
            })
            .map(parse_counts)
            .unwrap_or((0, 0));

        Ok(Some(GitStatus {
            branch,
            dirty,
            ahead,
            behind,
            last_commit: run(&["log", "-1", "--format=%s"]),
            last_commit_relative: run(&["log", "-1", "--format=%cr"]),
        }))
    })
    .await
    .map_err(|e| format!("The git status check failed unexpectedly: {e}"))?
}

// --- Git source control (commit & push) ------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub status: String,
}

/// Run a git command in `dir`; Ok(stdout) on success, Err(stderr) on failure.
fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("Could not run git: {e}. Is git installed and on your PATH?"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Parse an origin URL into an "owner/repo" slug (or return it unchanged).
fn parse_repo_slug(url: &str) -> String {
    let s = url.trim().trim_end_matches(".git");
    for prefix in [
        "git@github.com:",
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    s.to_string()
}

/// List uncommitted changes (porcelain), with a human-readable status.
#[tauri::command]
async fn git_changes(path: String) -> Result<Vec<GitChange>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let out = run_git(&p, &["status", "--porcelain"])?;
        let mut changes = Vec::new();
        for line in out.lines() {
            if line.len() < 4 {
                continue;
            }
            let code = &line[..2];
            let mut file = line[3..].to_string();
            if let Some(idx) = file.find(" -> ") {
                file = file[idx + 4..].to_string();
            }
            let status = if code == "??" {
                "Untracked"
            } else if code.contains('D') {
                "Deleted"
            } else if code.contains('A') {
                "Added"
            } else if code.contains('R') {
                "Renamed"
            } else if code.contains('M') {
                "Modified"
            } else {
                "Changed"
            };
            changes.push(GitChange {
                path: file,
                status: status.to_string(),
            });
        }
        Ok(changes)
    })
    .await
    .map_err(|e| format!("The git check failed unexpectedly: {e}"))?
}

/// The origin remote as an "owner/repo" slug, or None if there's no remote.
#[tauri::command]
async fn git_remote(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        match run_git(&p, &["remote", "get-url", "origin"]) {
            Ok(url) => Ok(Some(parse_repo_slug(url.trim()))),
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("The git check failed unexpectedly: {e}"))?
}

/// Stage everything and commit with `message`.
#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let msg = message.trim();
        if msg.is_empty() {
            return Err("Enter a commit message.".to_string());
        }
        run_git(&p, &["add", "-A"])?;
        run_git(&p, &["commit", "-m", msg]).map(|_| ()).map_err(|e| {
            if e.contains("nothing to commit") {
                "Nothing to commit.".to_string()
            } else if e.contains("Please tell me who you are") || e.contains("user.email") {
                "Git identity isn't set. Run: git config --global user.name \"You\" and git config --global user.email you@example.com".to_string()
            } else {
                format!("Commit failed: {e}")
            }
        })
    })
    .await
    .map_err(|e| format!("The commit task failed unexpectedly: {e}"))?
}

/// Push the current branch to origin. If `token` is provided and the remote is
/// GitHub, push via an authenticated HTTPS URL; otherwise use the existing
/// credentials. The token is never returned in error text.
#[tauri::command]
async fn git_push(path: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let branch = run_git(&p, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map_err(|e| format!("Could not read the branch: {e}"))?;
        let branch = branch.trim();
        let remote_url = run_git(&p, &["remote", "get-url", "origin"])
            .map_err(|_| "No 'origin' remote is configured for this project.".to_string())?;
        let remote_url = remote_url.trim();
        let token = token.trim();
        let refspec = format!("HEAD:{branch}");

        let result = if !token.is_empty() && remote_url.contains("github.com") {
            let slug = parse_repo_slug(remote_url);
            let auth = format!("https://{token}@github.com/{slug}.git");
            run_git(&p, &["push", &auth, &refspec])
        } else {
            run_git(&p, &["push", "origin", &refspec])
        };

        result.map(|_| ()).map_err(|e| {
            // Never leak the token if git echoed the URL back in an error.
            let scrubbed = if token.is_empty() {
                e
            } else {
                e.replace(token, "***")
            };
            format!("Push failed: {scrubbed}")
        })
    })
    .await
    .map_err(|e| format!("The push task failed unexpectedly: {e}"))?
}

/// Fetch from origin without touching the working tree. Updates the local
/// `origin/*` tracking refs (so `git_status`'s behind/ahead counts populate).
/// When a GitHub token is given it's used for private-repo auth, never echoed.
#[tauri::command]
async fn git_fetch(path: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let remote_url = run_git(&p, &["remote", "get-url", "origin"])
            .map_err(|_| "No 'origin' remote is configured for this project.".to_string())?;
        let remote_url = remote_url.trim();
        let token = token.trim();

        let result = if !token.is_empty() && remote_url.contains("github.com") {
            let slug = parse_repo_slug(remote_url);
            let auth = format!("https://{token}@github.com/{slug}.git");
            // Fetching from an explicit URL would only write FETCH_HEAD, so map
            // the refs into `origin/*` ourselves to keep tracking refs current.
            run_git(&p, &["fetch", &auth, "+refs/heads/*:refs/remotes/origin/*"])
        } else {
            run_git(&p, &["fetch", "origin"])
        };

        result.map(|_| ()).map_err(|e| {
            let scrubbed = if token.is_empty() { e } else { e.replace(token, "***") };
            format!("Fetch failed: {scrubbed}")
        })
    })
    .await
    .map_err(|e| format!("The fetch task failed unexpectedly: {e}"))?
}

/// Pull the current branch from origin, **fast-forward only** so it never
/// creates a surprise merge commit. If the branch has diverged, it fails with a
/// plain-English message pointing the user to resolve it in a terminal. The
/// token (for private GitHub repos) is never returned in error text.
#[tauri::command]
async fn git_pull(path: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let branch = run_git(&p, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map_err(|e| format!("Could not read the branch: {e}"))?;
        let branch = branch.trim();
        let remote_url = run_git(&p, &["remote", "get-url", "origin"])
            .map_err(|_| "No 'origin' remote is configured for this project.".to_string())?;
        let remote_url = remote_url.trim();
        let token = token.trim();

        let result = if !token.is_empty() && remote_url.contains("github.com") {
            let slug = parse_repo_slug(remote_url);
            let auth = format!("https://{token}@github.com/{slug}.git");
            run_git(&p, &["pull", "--ff-only", &auth, branch])
        } else {
            run_git(&p, &["pull", "--ff-only", "origin", branch])
        };

        result.map(|_| ()).map_err(|e| {
            let scrubbed = if token.is_empty() { e } else { e.replace(token, "***") };
            // Translate the common fast-forward refusal into something plain.
            if scrubbed.contains("Not possible to fast-forward")
                || scrubbed.contains("non-fast-forward")
                || scrubbed.contains("diverging")
            {
                "Your local branch and origin have both moved on (diverged). Commit or stash your work, then merge/rebase in a terminal — Kinetek only does safe fast-forward pulls.".to_string()
            } else {
                format!("Pull failed: {scrubbed}")
            }
        })
    })
    .await
    .map_err(|e| format!("The pull task failed unexpectedly: {e}"))?
}

/// Initialize a git repo (default branch `main`) if one doesn't exist.
#[tauri::command]
async fn git_init(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_dir() {
            return Err(format!("\"{}\" is not a folder.", p.display()));
        }
        if p.join(".git").exists() {
            return Ok(());
        }
        run_git(&p, &["init", "-b", "main"])
            .or_else(|_| run_git(&p, &["init"]))
            .map(|_| ())
            .map_err(|e| format!("git init failed: {e}"))
    })
    .await
    .map_err(|e| format!("The init task failed unexpectedly: {e}"))?
}

/// Point the project's `origin` remote at `url` (add if missing, else update).
#[tauri::command]
async fn git_set_remote(path: String, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let result = if run_git(&p, &["remote", "get-url", "origin"]).is_ok() {
            run_git(&p, &["remote", "set-url", "origin", &url])
        } else {
            run_git(&p, &["remote", "add", "origin", &url])
        };
        result.map(|_| ()).map_err(|e| format!("Could not set the remote: {e}"))
    })
    .await
    .map_err(|e| format!("The remote task failed unexpectedly: {e}"))?
}

// --- Git history (commit graph) --------------------------------------------

/// One commit in the history, with enough parent/ref info to draw a Fork-style
/// graph on the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    /// Parent hashes (first = mainline parent). Merge commits have 2+.
    pub parents: Vec<String>,
    /// Decorations: branch/tag/HEAD names attached to this commit.
    pub refs: Vec<String>,
    /// Whether HEAD points at (or through) this commit.
    pub is_head: bool,
    pub author: String,
    pub email: String,
    /// ISO-8601 commit date.
    pub date_iso: String,
    /// Human "3 days ago" commit date.
    pub date_relative: String,
    pub subject: String,
    /// Full commit body (may be empty).
    pub body: String,
}

/// Read the commit history across all branches (most recent first), parsed for
/// the visual graph. Returns Err if the folder isn't a git repo.
#[tauri::command]
async fn git_log(path: String, limit: Option<u32>) -> Result<Vec<CommitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let n = limit.unwrap_or(300).to_string();
        // Field separator \x1f, record separator \x1e — safe against newlines in
        // the body/subject. Fields: H, h, P, D, an, ae, cI, cr, s, b.
        let fmt = "%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%cI%x1f%cr%x1f%s%x1f%b%x1e";
        let out = run_git(
            &p,
            &[
                "log",
                "--all",
                "--date-order",
                "-n",
                &n,
                &format!("--pretty=format:{fmt}"),
            ],
        )?;

        let mut commits = Vec::new();
        for record in out.split('\u{1e}') {
            let record = record.trim_start_matches('\n');
            if record.trim().is_empty() {
                continue;
            }
            let f: Vec<&str> = record.split('\u{1f}').collect();
            if f.len() < 9 {
                continue;
            }
            let parents: Vec<String> = f[2]
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            let mut is_head = false;
            let refs: Vec<String> = f[3]
                .split(", ")
                .filter_map(|raw| {
                    let r = raw.trim();
                    if r.is_empty() {
                        return None;
                    }
                    // "HEAD -> main" → mark head, keep "main".
                    if let Some(rest) = r.strip_prefix("HEAD -> ") {
                        is_head = true;
                        return Some(rest.to_string());
                    }
                    if r == "HEAD" {
                        is_head = true;
                        return Some("HEAD".to_string());
                    }
                    Some(r.to_string())
                })
                .collect();

            commits.push(CommitInfo {
                hash: f[0].to_string(),
                short_hash: f[1].to_string(),
                parents,
                refs,
                is_head,
                author: f[4].to_string(),
                email: f[5].to_string(),
                date_iso: f[6].to_string(),
                date_relative: f[7].to_string(),
                subject: f[8].to_string(),
                body: f.get(9).map(|s| s.trim_end().to_string()).unwrap_or_default(),
            });
        }
        Ok(commits)
    })
    .await
    .map_err(|e| format!("The git log task failed unexpectedly: {e}"))?
}

/// Clone a GitHub repo into `dest` (a parent folder). Returns a project card for
/// the freshly-cloned folder. The token (if given) is used only for the clone
/// transport and is scrubbed from the saved remote and any error text.
#[tauri::command]
async fn git_clone(url: String, dest: String, token: String) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parent = PathBuf::from(&dest);
        if !parent.is_dir() {
            return Err(format!("\"{}\" is not a folder.", parent.display()));
        }
        let clean_url = url.trim().to_string();
        // Folder name = repo name (last path segment, sans .git).
        let name = clean_url
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .rsplit('/')
            .next()
            .unwrap_or("repo")
            .to_string();
        if name.is_empty() {
            return Err("Could not work out a folder name from that URL.".to_string());
        }
        let target = parent.join(&name);
        if target.exists() {
            return Err(format!(
                "A folder named \"{name}\" already exists here. Move or rename it first."
            ));
        }

        let token = token.trim();
        let target_str = target.to_string_lossy().to_string();
        let transport = if !token.is_empty() && clean_url.contains("github.com") {
            let slug = parse_repo_slug(&clean_url);
            format!("https://{token}@github.com/{slug}.git")
        } else {
            clean_url.clone()
        };

        // Clone from the parent directory into `name`.
        run_git(&parent, &["clone", &transport, &name]).map_err(|e| {
            let scrubbed = if token.is_empty() { e } else { e.replace(token, "***") };
            format!("Clone failed: {scrubbed}")
        })?;

        // Never persist the token inside the cloned repo's remote URL.
        if transport != clean_url {
            let _ = run_git(&target, &["remote", "set-url", "origin", &clean_url]);
        }

        Ok(ProjectInfo {
            id: target_str.clone(),
            name,
            path: target_str,
            summary: String::new(),
            status: "In Development".into(),
            frameworks: detect_frameworks(&target),
            has_preview: target.join("package.json").exists(),
            stack: None,
        })
    })
    .await
    .map_err(|e| format!("The clone task failed unexpectedly: {e}"))?
}

/// Local changes for a file (or the whole working tree) as a unified diff vs the
/// last commit. Untracked single files are synthesized as an all-added diff so
/// the user can still see their contents.
#[tauri::command]
async fn git_diff(path: String, file: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }

        // Untracked single file → show its contents as added lines.
        if let Some(f) = &file {
            let porcelain = run_git(&p, &["status", "--porcelain", "--", f]).unwrap_or_default();
            if porcelain.lines().any(|l| l.starts_with("??")) {
                let content = fs::read_to_string(p.join(f)).unwrap_or_default();
                let mut out = format!("diff --git a/{f} b/{f}\nnew file\n--- /dev/null\n+++ b/{f}\n");
                for line in content.lines() {
                    out.push('+');
                    out.push_str(line);
                    out.push('\n');
                }
                return Ok(out);
            }
        }

        // Tracked changes vs HEAD (staged + unstaged). Falls back to the index
        // diff if there are no commits yet.
        let with_head: Vec<String> = {
            let mut a = vec!["diff".to_string(), "HEAD".to_string()];
            if let Some(f) = &file {
                a.push("--".into());
                a.push(f.clone());
            }
            a
        };
        let refs: Vec<&str> = with_head.iter().map(|s| s.as_str()).collect();
        match run_git(&p, &refs) {
            Ok(out) => Ok(out),
            Err(e) if e.contains("ambiguous argument") || e.contains("unknown revision") => {
                let mut a = vec!["diff"];
                if let Some(f) = &file {
                    a.push("--");
                    a.push(f.as_str());
                }
                run_git(&p, &a)
            }
            Err(e) => Err(format!("Could not read the diff: {e}")),
        }
    })
    .await
    .map_err(|e| format!("The diff task failed unexpectedly: {e}"))?
}

/// Remove the `origin` remote (used after deleting the GitHub repo). The local
/// files and history stay; the project just becomes "not connected".
#[tauri::command]
async fn git_remove_remote(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let _ = run_git(&p, &["remote", "remove", "origin"]);
        Ok(())
    })
    .await
    .map_err(|e| format!("The remote task failed unexpectedly: {e}"))?
}

// --- Git refs (branches / remotes / tags) + stashes ------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefs {
    /// Current branch (or "HEAD" when detached).
    pub current: String,
    pub detached: bool,
    pub branches: Vec<String>,
    /// Remote-tracking branches, e.g. "origin/main".
    pub remotes: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// Position in the stash list (stash@{index}).
    pub index: usize,
    pub message: String,
}

/// Split command output into trimmed, non-empty lines.
fn split_lines(out: String) -> Vec<String> {
    out.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// List branches, remote-tracking branches, and tags for the refs sidebar.
#[tauri::command]
async fn git_refs(path: String) -> Result<GitRefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let current = run_git(&p, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_default()
            .trim()
            .to_string();
        let detached = current.is_empty() || current == "HEAD";
        let branches = run_git(&p, &["branch", "--format=%(refname:short)"])
            .map(split_lines)
            .unwrap_or_default();
        let remotes = run_git(&p, &["branch", "-r", "--format=%(refname:short)"])
            .map(split_lines)
            .unwrap_or_default()
            .into_iter()
            .filter(|r| !r.ends_with("/HEAD"))
            .collect();
        let tags = run_git(&p, &["tag", "--sort=-creatordate"])
            .map(split_lines)
            .unwrap_or_default();
        Ok(GitRefs {
            current,
            detached,
            branches,
            remotes,
            tags,
        })
    })
    .await
    .map_err(|e| format!("The refs task failed unexpectedly: {e}"))?
}

/// Create a branch (optionally at a specific commit, optionally checking it out).
#[tauri::command]
async fn git_create_branch(
    path: String,
    name: String,
    at: Option<String>,
    checkout: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("Enter a branch name.".to_string());
        }
        let mut args: Vec<&str> = if checkout {
            vec!["checkout", "-b", &name]
        } else {
            vec!["branch", &name]
        };
        if let Some(a) = at.as_deref() {
            if !a.trim().is_empty() {
                args.push(a.trim());
            }
        }
        run_git(&p, &args).map(|_| ()).map_err(|e| {
            if e.contains("already exists") {
                format!("A branch named \"{name}\" already exists.")
            } else {
                format!("Could not create the branch: {e}")
            }
        })
    })
    .await
    .map_err(|e| format!("The branch task failed unexpectedly: {e}"))?
}

/// Switch to a branch/ref. Friendly error when uncommitted changes conflict.
#[tauri::command]
async fn git_checkout(path: String, reference: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let r = reference.trim();
        if r.is_empty() {
            return Err("No branch given.".to_string());
        }
        run_git(&p, &["checkout", r]).map(|_| ()).map_err(|e| {
            if e.contains("would be overwritten") || e.contains("local changes") {
                "You have uncommitted changes that would conflict. Commit or stash them first.".to_string()
            } else {
                format!("Could not switch branch: {e}")
            }
        })
    })
    .await
    .map_err(|e| format!("The checkout task failed unexpectedly: {e}"))?
}

/// Delete a local branch (force to discard an unmerged one).
#[tauri::command]
async fn git_delete_branch(path: String, name: String, force: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let name = name.trim();
        let flag = if force { "-D" } else { "-d" };
        run_git(&p, &["branch", flag, name]).map(|_| ()).map_err(|e| {
            if e.contains("not fully merged") {
                format!("\"{name}\" has unmerged commits. Use force-delete to discard them.")
            } else {
                format!("Could not delete the branch: {e}")
            }
        })
    })
    .await
    .map_err(|e| format!("The branch task failed unexpectedly: {e}"))?
}

/// List saved stashes (most recent first).
#[tauri::command]
async fn git_stashes(path: String) -> Result<Vec<StashEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.join(".git").exists() {
            return Err("This project isn't a git repository.".to_string());
        }
        let out = run_git(&p, &["stash", "list", "--format=%gs"]).unwrap_or_default();
        Ok(out
            .lines()
            .enumerate()
            .map(|(index, line)| StashEntry {
                index,
                // Strip the noisy "WIP on <branch>: <sha> " prefix when present.
                message: line
                    .split_once(": ")
                    .map(|(_, rest)| rest)
                    .unwrap_or(line)
                    .trim()
                    .to_string(),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("The stash task failed unexpectedly: {e}"))?
}

/// Stash the working tree (including untracked files) so it isn't pushed yet.
#[tauri::command]
async fn git_stash_save(path: String, message: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked"];
        let msg = message.unwrap_or_default();
        let msg = msg.trim();
        if !msg.is_empty() {
            args.push("-m");
            args.push(msg);
        }
        run_git(&p, &args).map(|_| ()).map_err(|e| {
            if e.contains("No local changes") {
                "There are no changes to stash.".to_string()
            } else {
                format!("Could not stash: {e}")
            }
        })
    })
    .await
    .map_err(|e| format!("The stash task failed unexpectedly: {e}"))?
}

/// Apply a stash by index. `pop` removes it from the list afterwards.
#[tauri::command]
async fn git_stash_apply(path: String, index: usize, pop: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let stash = format!("stash@{{{index}}}");
        let verb = if pop { "pop" } else { "apply" };
        run_git(&p, &["stash", verb, &stash])
            .map(|_| ())
            .map_err(|e| {
                if e.contains("conflict") {
                    "Applying the stash hit a conflict — resolve it in your editor.".to_string()
                } else {
                    format!("Could not apply the stash: {e}")
                }
            })
    })
    .await
    .map_err(|e| format!("The stash task failed unexpectedly: {e}"))?
}

/// Delete a stash by index.
#[tauri::command]
async fn git_stash_drop(path: String, index: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let stash = format!("stash@{{{index}}}");
        run_git(&p, &["stash", "drop", &stash])
            .map(|_| ())
            .map_err(|e| format!("Could not drop the stash: {e}"))
    })
    .await
    .map_err(|e| format!("The stash task failed unexpectedly: {e}"))?
}

// --- Claude Code delegation ------------------------------------------------

/// Tracks running `claude` agent processes (run id → pid) so they can be stopped.
/// `Arc` so the map can be moved into the blocking worker that owns the run.
#[derive(Default)]
struct ClaudeState(Arc<Mutex<HashMap<String, u32>>>);

/// Check a single tool from the catalog (e.g. "claude") — used by the UI to
/// detect whether Claude Code is installed before offering it.
#[tauri::command]
async fn check_tool(key: String) -> Result<Prerequisite, String> {
    tauri::async_runtime::spawn_blocking(move || check_one(&key, true))
        .await
        .map_err(|e| format!("The tool check failed unexpectedly: {e}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeLine {
    run_id: String,
    line: String,
    stream: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDone {
    run_id: String,
    ok: bool,
}

/// Delegate a prompt to the installed Claude Code CLI, running in the project's
/// directory so it has full context of that project. Output streams to the UI
/// via `claude-output` events; a final `claude-done` event reports the outcome.
/// `mode` maps to Claude Code's `--permission-mode` ("plan" = safe/read-only,
/// "acceptEdits" = allowed to change files). The user's own Claude Code auth is
/// used — Kinetek handles no secret for this.
#[tauri::command]
async fn run_claude_agent(
    app: tauri::AppHandle,
    state: State<'_, ClaudeState>,
    run_id: String,
    project_path: String,
    prompt: String,
    mode: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let path = PathBuf::from(&project_path);
    if !path.is_dir() {
        return Err(format!("The path \"{}\" no longer exists.", path.display()));
    }
    if tool_present("claude", &["--version"]).is_none() {
        return Err("Claude Code isn't installed. Install the `claude` CLI, then try again.".into());
    }
    let mode = match mode.as_str() {
        "acceptEdits" | "plan" | "default" | "bypassPermissions" => mode,
        _ => "plan".to_string(),
    };
    // Clone the Arc so the blocking worker (which owns the run) can update it.
    let pids = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_claude_inner(app, pids, run_id, path, prompt, mode, session_id)
    })
    .await
    .map_err(|e| format!("The Claude task failed unexpectedly: {e}"))?
}

fn run_claude_inner(
    app: tauri::AppHandle,
    pids: Arc<Mutex<HashMap<String, u32>>>,
    run_id: String,
    path: PathBuf,
    prompt: String,
    mode: String,
    session_id: Option<String>,
) -> Result<(), String> {
    // Stream JSON events (NDJSON) so the UI shows activity as it happens — the
    // default text mode buffers until the whole turn finishes (feels "stuck").
    // `--verbose` is required for stream-json in print mode.
    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        mode,
    ];
    // Resume the existing Claude Code session so the conversation keeps its
    // memory across turns. Absent/empty → a fresh session (the CLI mints one,
    // whose id comes back to the UI in the stream-json `init`/`result` events).
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        args.push("--resume".to_string());
        args.push(sid);
    }
    let mut cmd = make_command("claude", &args);
    cmd.current_dir(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start Claude Code: {e}. Is `claude` on your PATH?"))?;

    // Track the pid so `stop_claude` can signal the whole process group.
    if let Ok(mut map) = pids.lock() {
        map.insert(run_id.clone(), child.id());
    }

    let mut handles = Vec::new();
    if let Some(out) = child.stdout.take() {
        let app1 = app.clone();
        let id1 = run_id.clone();
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app1.emit(
                    "claude-output",
                    ClaudeLine { run_id: id1.clone(), line, stream: "stdout".into() },
                );
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        let id2 = run_id.clone();
        handles.push(std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app2.emit(
                    "claude-output",
                    ClaudeLine { run_id: id2.clone(), line, stream: "stderr".into() },
                );
            }
        }));
    }

    let status = child.wait();
    for h in handles {
        let _ = h.join();
    }
    if let Ok(mut map) = pids.lock() {
        map.remove(&run_id);
    }

    let ok = status.map(|s| s.success()).unwrap_or(false);
    let _ = app.emit("claude-done", ClaudeDone { run_id, ok });
    Ok(())
}

/// Stop a running Claude Code agent (signals its process group on Unix).
#[tauri::command]
fn stop_claude(state: State<'_, ClaudeState>, run_id: String) -> Result<(), String> {
    if let Some(pid) = state.0.lock().ok().and_then(|m| m.get(&run_id).copied()) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
    Ok(())
}

// --- Interactive terminal (PTY) --------------------------------------------

/// One live PTY session: the master (for resize), a writer for input, and the
/// child shell (so it can be killed on close).
struct TermSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct TerminalState(Mutex<HashMap<String, TermSession>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermData {
    id: String,
    /// Raw PTY output bytes (xterm decodes UTF-8 itself).
    bytes: Vec<u8>,
}

/// Open a real interactive shell in a PTY, rooted at `cwd`. Output streams to
/// the UI as `terminal-output` events; shell exit emits `terminal-exit`.
#[tauri::command]
fn terminal_open(
    app: tauri::AppHandle,
    state: State<'_, TerminalState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Could not open a terminal: {e}"))?;

    // The user's own shell, as a login shell so PATH (nvm, brew, …) is loaded.
    let shell = if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        // Default macOS shell is zsh; default Linux shell is bash. `$SHELL` is set
        // in any real desktop session, so the fallback is only a last resort.
        std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
        })
    };
    let mut cmd = CommandBuilder::new(&shell);
    #[cfg(unix)]
    cmd.arg("-l");
    let dir = PathBuf::from(&cwd);
    if dir.is_dir() {
        cmd.cwd(&dir);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Could not start the shell: {e}"))?;
    drop(pair.slave); // release the slave end now the child holds it

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Could not write to the terminal: {e}"))?;

    // Pump PTY output → UI events until the shell exits.
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app2.emit(
                        "terminal-output",
                        TermData { id: id2.clone(), bytes: buf[..n].to_vec() },
                    );
                }
            }
        }
        let _ = app2.emit("terminal-exit", id2.clone());
    });

    state
        .0
        .lock()
        .unwrap()
        .insert(id, TermSession { master: pair.master, writer, child });
    Ok(())
}

/// Send keystrokes/input to a terminal session.
#[tauri::command]
fn terminal_write(state: State<'_, TerminalState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .and_then(|_| s.writer.flush())
            .map_err(|e| format!("Could not write to the terminal: {e}"))?;
    }
    Ok(())
}

/// Resize a terminal session (after the xterm view is fitted/resized).
#[tauri::command]
fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    if let Some(s) = map.get(&id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Could not resize the terminal: {e}"))?;
    }
    Ok(())
}

/// Close a terminal session and kill its shell.
#[tauri::command]
fn terminal_close(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

// --- File explorer (read-only) ---------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Dotfiles, so the UI can hide them by default.
    pub hidden: bool,
}

/// List a directory's immediate children (folders first, then files, A→Z).
/// Read-only — used by the visual file Explorer.
#[tauri::command]
async fn read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err(format!("\"{}\" is not a folder.", dir.display()));
        }
        let mut entries: Vec<DirEntryInfo> = Vec::new();
        let read = fs::read_dir(&dir)
            .map_err(|e| format!("Could not read \"{}\": {e}", dir.display()))?;
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry
                .file_type()
                .map(|t| t.is_dir())
                .unwrap_or_else(|_| entry.path().is_dir());
            entries.push(DirEntryInfo {
                hidden: name.starts_with('.'),
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            });
        }
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    })
    .await
    .map_err(|e| format!("Reading the folder failed unexpectedly: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    /// Content was cut off at the character cap.
    pub truncated: bool,
    /// Not valid UTF-8 (binary).
    pub binary: bool,
    /// File exceeds the viewer's byte cap.
    pub too_large: bool,
    pub size: u64,
}

const MAX_VIEW_BYTES: u64 = 2_000_000;
const MAX_VIEW_CHARS: usize = 400_000;

/// Read a file's text for the read-only viewer. Flags binary or oversized files
/// instead of dumping garbage.
#[tauri::command]
async fn read_file_text(path: String) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p)
            .map_err(|e| format!("Could not read \"{}\": {e}", p.display()))?;
        if !meta.is_file() {
            return Err("That path is not a file.".into());
        }
        let size = meta.len();
        if size > MAX_VIEW_BYTES {
            return Ok(FileContent {
                content: String::new(),
                truncated: false,
                binary: false,
                too_large: true,
                size,
            });
        }
        let bytes = fs::read(&p).map_err(|e| format!("Could not read file: {e}"))?;
        match String::from_utf8(bytes) {
            Ok(s) => {
                let truncated = s.chars().count() > MAX_VIEW_CHARS;
                let content = if truncated {
                    s.chars().take(MAX_VIEW_CHARS).collect()
                } else {
                    s
                };
                Ok(FileContent {
                    content,
                    truncated,
                    binary: false,
                    too_large: false,
                    size,
                })
            }
            Err(_) => Ok(FileContent {
                content: String::new(),
                truncated: false,
                binary: true,
                too_large: false,
                size,
            }),
        }
    })
    .await
    .map_err(|e| format!("Reading the file failed unexpectedly: {e}"))?
}

/// Write UTF-8 text to a file (in-app editor save). Creates parent dirs.
#[tauri::command]
async fn write_file_text(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        fs::write(&p, content).map_err(|e| format!("Could not save {}: {e}", p.display()))
    })
    .await
    .map_err(|e| format!("The save task failed unexpectedly: {e}"))?
}

/// One editor diagnostic (a syntax error/warning) for the gutter squiggles.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub line: u32,
    pub column: u32,
    pub message: String,
    /// "error" | "warning".
    pub severity: String,
}

/// On-save syntax check for languages Monaco can't natively diagnose. Uses the
/// language's own tool when present (Python → py_compile, Go → gofmt -e). Returns
/// an empty list when the file is fine, the language is handled by Monaco, or the
/// tool isn't installed (so it never blocks saving).
#[tauri::command]
async fn check_syntax(path: String) -> Result<Vec<Diagnostic>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        match ext.as_str() {
            "py" => Ok(check_python(&p)),
            "go" => Ok(check_go(&p)),
            _ => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| format!("The syntax check failed unexpectedly: {e}"))?
}

/// `python -m py_compile <file>` — catches syntax + indentation errors.
fn check_python(p: &Path) -> Vec<Diagnostic> {
    let py = if cfg!(target_os = "windows") { "python" } else { "python3" };
    let out = match Command::new(py)
        .args(["-m", "py_compile", &p.to_string_lossy()])
        .stdin(Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(), // python not installed → can't check
    };
    if out.status.success() {
        return Vec::new();
    }
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // Pull the line number and the "SomethingError: message" out of the trace.
    let line = text
        .split(", line ")
        .nth(1)
        .or_else(|| text.split("line ").nth(1))
        .and_then(|s| s.trim_start().split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(1);
    let message = text
        .lines()
        .rev()
        .find(|l| l.contains("Error:") || l.contains("Error "))
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "Python syntax error.".to_string());
    vec![Diagnostic { line, column: 1, message, severity: "error".into() }]
}

/// `gofmt -e <file>` — reports parse errors as `file:line:col: message`.
fn check_go(p: &Path) -> Vec<Diagnostic> {
    let out = match Command::new("gofmt")
        .arg("-e")
        .arg(p)
        .stdin(Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if out.status.success() {
        return Vec::new();
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut diags = Vec::new();
    for l in stderr.lines() {
        // <path>:<line>:<col>: <message>
        let parts: Vec<&str> = l.splitn(4, ':').collect();
        if parts.len() == 4 {
            let line = parts[1].trim().parse::<u32>().unwrap_or(1);
            let column = parts[2].trim().parse::<u32>().unwrap_or(1);
            diags.push(Diagnostic {
                line,
                column,
                message: parts[3].trim().to_string(),
                severity: "error".into(),
            });
        }
    }
    diags
}

/// One detected HTTP route in an API (best-effort, not a real parser).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub method: String,
    pub route: String,
    /// Path relative to the scanned API folder.
    pub file: String,
    pub line: u32,
}

/// Compiled route patterns for the supported API frameworks.
struct EndpointPatterns {
    js_route: Regex, // express/fastify: app.get('/x')   → g1 method, g2 route
    nest: Regex,     // NestJS decorators: @Get('x')     → g1 method, g2 route?
    py_dec: Regex,   // FastAPI: @app.get("/x")          → g1 method, g2 route
    py_route: Regex, // Flask: @app.route("/x")          → g1 route (method ANY)
    cs_attr: Regex,  // ASP.NET: [HttpGet("x")]          → g1 method, g2 route?
    cs_map: Regex,   // minimal API: .MapGet("/x", …)    → g1 method, g2 route
    go_route: Regex, // net/http + gin/chi: .GET("/x")   → g1 verb, g2 route
}

impl EndpointPatterns {
    fn new() -> Self {
        EndpointPatterns {
            js_route: Regex::new(r#"(?i)\b(?:app|router|api|server|route)\.(get|post|put|patch|delete|all|options|head)\s*\(\s*["']([^"']+)"#).unwrap(),
            nest: Regex::new(r#"@(Get|Post|Put|Patch|Delete|All)\s*\(\s*["']?([^"')]*)"#).unwrap(),
            py_dec: Regex::new(r#"(?i)@\w+\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)"#).unwrap(),
            py_route: Regex::new(r#"@\w+\.route\s*\(\s*["']([^"']+)"#).unwrap(),
            cs_attr: Regex::new(r#"\[Http(Get|Post|Put|Patch|Delete)(?:\s*\(\s*"([^"]*)"\s*\))?\]"#).unwrap(),
            cs_map: Regex::new(r#"(?i)\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)""#).unwrap(),
            go_route: Regex::new(r#"(?i)\.(HandleFunc|GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)""#).unwrap(),
        }
    }

    fn scan_line(&self, ext: &str, line: &str, lineno: u32, rel: &str, out: &mut Vec<Endpoint>) {
        let mut push = |method: &str, route: &str| {
            out.push(Endpoint {
                method: method.to_uppercase(),
                route: if route.trim().is_empty() { "/".into() } else { route.to_string() },
                file: rel.to_string(),
                line: lineno,
            });
        };
        match ext {
            "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs" => {
                for c in self.js_route.captures_iter(line) {
                    push(&c[1], &c[2]);
                }
                for c in self.nest.captures_iter(line) {
                    push(&c[1], c.get(2).map(|m| m.as_str()).unwrap_or(""));
                }
            }
            "py" => {
                for c in self.py_dec.captures_iter(line) {
                    push(&c[1], &c[2]);
                }
                for c in self.py_route.captures_iter(line) {
                    push("ANY", &c[1]);
                }
            }
            "cs" => {
                for c in self.cs_attr.captures_iter(line) {
                    push(&c[1], c.get(2).map(|m| m.as_str()).unwrap_or(""));
                }
                for c in self.cs_map.captures_iter(line) {
                    push(&c[1], &c[2]);
                }
            }
            "go" => {
                for c in self.go_route.captures_iter(line) {
                    let verb = &c[1];
                    let method = if verb.eq_ignore_ascii_case("HandleFunc") { "ANY" } else { verb };
                    push(method, &c[2]);
                }
            }
            _ => {}
        }
    }
}

fn scan_endpoints(
    root: &Path,
    dir: &Path,
    pats: &EndpointPatterns,
    out: &mut Vec<Endpoint>,
    files: &mut usize,
) {
    if *files > 1500 {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if SEARCH_SKIP.contains(&name.as_str()) {
                continue;
            }
            scan_endpoints(root, &p, pats, out, files);
        } else {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !matches!(ext.as_str(), "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs" | "py" | "cs" | "go")
            {
                continue;
            }
            *files += 1;
            if *files > 1500 {
                return;
            }
            let content = match fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.len() > 600_000 {
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().to_string();
            for (i, line) in content.lines().enumerate() {
                pats.scan_line(&ext, line, (i as u32) + 1, &rel, out);
            }
        }
    }
}

/// Heuristically list the HTTP routes an API exposes (for the API explorer).
#[tauri::command]
async fn detect_endpoints(path: String) -> Result<Vec<Endpoint>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("\"{}\" is not a folder.", root.display()));
        }
        let pats = EndpointPatterns::new();
        let mut out: Vec<Endpoint> = Vec::new();
        let mut files = 0usize;
        scan_endpoints(&root, &root, &pats, &mut out, &mut files);
        out.sort_by(|a, b| a.route.cmp(&b.route).then(a.method.cmp(&b.method)));
        out.dedup_by(|a, b| {
            a.method == b.method && a.route == b.route && a.file == b.file && a.line == b.line
        });
        Ok(out)
    })
    .await
    .map_err(|e| format!("The endpoint scan failed unexpectedly: {e}"))?
}

/// One outbound API call found in the app (the consumer side of the contract).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCall {
    pub method: String,
    pub url: String,
    pub file: String,
    pub line: u32,
}

struct ApiCallPatterns {
    fetch: Regex, // fetch("/x")            → g1 url (method assumed GET)
    verb: Regex,  // axios/api.get("/x")    → g1 method, g2 url
}

impl ApiCallPatterns {
    fn new() -> Self {
        ApiCallPatterns {
            fetch: Regex::new(r#"(?i)\bfetch\s*\(\s*["'\x60]([^"'\x60?]+)"#).unwrap(),
            verb: Regex::new(r#"(?i)\b(?:axios|api|http|client|\$fetch|request)\.(get|post|put|patch|delete)\s*\(\s*["'\x60]([^"'\x60?]+)"#).unwrap(),
        }
    }

    fn scan_line(&self, line: &str, lineno: u32, rel: &str, out: &mut Vec<ApiCall>) {
        let mut push = |method: &str, url: &str| {
            // Only keep things that look like API paths/URLs.
            if url.starts_with('/') || url.starts_with("http") {
                out.push(ApiCall {
                    method: method.to_uppercase(),
                    url: url.to_string(),
                    file: rel.to_string(),
                    line: lineno,
                });
            }
        };
        for c in self.verb.captures_iter(line) {
            push(&c[1], &c[2]);
        }
        for c in self.fetch.captures_iter(line) {
            push("GET", &c[1]);
        }
    }
}

fn scan_api_calls(
    root: &Path,
    dir: &Path,
    pats: &ApiCallPatterns,
    out: &mut Vec<ApiCall>,
    files: &mut usize,
) {
    if *files > 1500 {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if SEARCH_SKIP.contains(&name.as_str()) {
                continue;
            }
            scan_api_calls(root, &p, pats, out, files);
        } else {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !matches!(ext.as_str(), "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs" | "vue" | "svelte") {
                continue;
            }
            *files += 1;
            if *files > 1500 {
                return;
            }
            let content = match fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.len() > 600_000 {
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().to_string();
            for (i, line) in content.lines().enumerate() {
                pats.scan_line(line, (i as u32) + 1, &rel, out);
            }
        }
    }
}

/// Heuristically list the API calls the app makes (the consumer side), so the
/// contract view can flag drift against what the API actually exposes.
#[tauri::command]
async fn detect_api_calls(path: String) -> Result<Vec<ApiCall>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("\"{}\" is not a folder.", root.display()));
        }
        let pats = ApiCallPatterns::new();
        let mut out: Vec<ApiCall> = Vec::new();
        let mut files = 0usize;
        scan_api_calls(&root, &root, &pats, &mut out, &mut files);
        out.sort_by(|a, b| a.url.cmp(&b.url).then(a.method.cmp(&b.method)));
        out.dedup_by(|a, b| a.method == b.method && a.url == b.url && a.file == b.file && a.line == b.line);
        Ok(out)
    })
    .await
    .map_err(|e| format!("The API-call scan failed unexpectedly: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Path relative to the search root (for display).
    pub rel: String,
}

/// Directories we never descend into during search (noise / huge).
const SEARCH_SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    ".cache",
    ".turbo",
    "vendor",
];
const SEARCH_CAP: usize = 400;

fn search_walk(dir: &Path, root: &Path, q: &str, out: &mut Vec<SearchHit>) {
    if out.len() >= SEARCH_CAP {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        if out.len() >= SEARCH_CAP {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let path = entry.path();

        if name.to_lowercase().contains(q) {
            let rel = path
                .strip_prefix(root)
                .ok()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            out.push(SearchHit {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                is_dir,
                rel,
            });
        }

        // Recurse, but skip hidden dirs and known-noisy ones.
        if is_dir && !name.starts_with('.') && !SEARCH_SKIP.contains(&name.as_str()) {
            search_walk(&path, root, q, out);
        }
    }
}

/// Recursively find files/folders under `root` whose name contains `query`
/// (case-insensitive). Skips heavy dirs and caps results so it stays snappy.
#[tauri::command]
async fn search_files(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let root_path = PathBuf::from(&root);
        if !root_path.is_dir() {
            return Err(format!("\"{}\" is not a folder.", root_path.display()));
        }
        let mut out: Vec<SearchHit> = Vec::new();
        search_walk(&root_path, &root_path, &q, &mut out);
        out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| format!("The search failed unexpectedly: {e}"))?
}

/// Absolute path to the user's home directory (default Explorer root).
#[tauri::command]
fn home_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Could not resolve the home directory: {e}"))
}

// --- Open in editor --------------------------------------------------------

fn launch_cli_editor(cli: &str, mac_app: &str, args: &[String]) -> Result<(), String> {
    if let Ok(status) = make_command(cli, args).status() {
        if status.success() {
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut open_args = vec!["-a".to_string(), mac_app.to_string()];
        open_args.extend(args.iter().cloned());
        if let Ok(status) = Command::new("open").args(&open_args).status() {
            if status.success() {
                return Ok(());
            }
        }
    }
    Err(format!(
        "Could not open {mac_app}. Make sure it's installed and on your PATH."
    ))
}

/// Editor args: open `folder` as the workspace, plus `file` to focus (if given).
/// `code <folder> <file>` opens the folder as a project with the file in an editor.
fn editor_args(folder: &str, file: &Option<String>) -> Vec<String> {
    let mut v = vec![folder.to_string()];
    if let Some(f) = file {
        if !f.trim().is_empty() {
            v.push(f.clone());
        }
    }
    v
}

/// Open a project in the user's chosen editor. When `file` is given, the editor
/// opens `path` as the workspace AND focuses that file.
#[tauri::command]
fn open_in_editor(path: String, editor: String, file: Option<String>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("The path \"{}\" no longer exists.", p.display()));
    }
    let args = editor_args(&path, &file);
    match editor.as_str() {
        "vscode" => vscode_open(&args),
        "cursor" => launch_cli_editor("cursor", "Cursor", &args),
        "zed" => launch_cli_editor("zed", "Zed", &args),
        // Finder can't "open as workspace" — reveal the file if given, else folder.
        "finder" => open_in_file_manager(file.filter(|f| !f.trim().is_empty()).unwrap_or(path)),
        other => Err(format!("Unknown editor: {other}")),
    }
}

/// Write AI-generated files into an existing project folder.
///
/// Every path is validated to stay inside `project_path` — absolute paths and
/// any `..` traversal are rejected — so a bad/hostile model response can't
/// scribble outside the project. Returns the number of files written.
#[tauri::command]
async fn write_generated_files(
    project_path: String,
    files: Vec<GeneratedFile>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&project_path);
        if !root.is_dir() {
            return Err(format!(
                "Project folder \"{}\" doesn't exist.",
                root.display()
            ));
        }
        let canon_root = root
            .canonicalize()
            .map_err(|e| format!("Cannot resolve the project folder: {e}"))?;

        let mut written = 0usize;
        for f in &files {
            let rel = f.path.trim().replace('\\', "/");
            if rel.is_empty() {
                continue;
            }
            let rel_path = Path::new(&rel);
            if rel_path.is_absolute() || rel.split('/').any(|seg| seg == "..") {
                return Err(format!(
                    "Refusing to write outside the project: \"{}\"",
                    f.path
                ));
            }

            let target = root.join(rel_path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
                // Defense in depth: the realized parent must still be inside root.
                let canon_parent = parent
                    .canonicalize()
                    .map_err(|e| format!("Cannot resolve {}: {e}", parent.display()))?;
                if !canon_parent.starts_with(&canon_root) {
                    return Err(format!(
                        "Refusing to write outside the project: \"{}\"",
                        f.path
                    ));
                }
            }

            fs::write(&target, &f.contents)
                .map_err(|e| format!("Could not write {}: {e}", target.display()))?;
            written += 1;
        }
        Ok(written)
    })
    .await
    .map_err(|e| format!("The write task failed unexpectedly: {e}"))?
}

/// Resolve the path to the shared error log. Baked to the Kinetek repo root at
/// build time (`<repo>/kinetek-errors.log`); falls back to the working dir if
/// that location no longer exists (e.g. a bundled app on another machine).
fn error_log_path() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.parent().unwrap_or(manifest);
    if root.is_dir() {
        return root.join("kinetek-errors.log");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("kinetek-errors.log")
}

/// Append an error (with timestamp + context) to the shared log file so issues
/// are easy to track during development. Returns the log file path.
#[tauri::command]
fn log_error(timestamp: String, context: String, message: String) -> Result<String, String> {
    use std::io::Write;

    let path = error_log_path();
    let entry = format!("[{timestamp}] [{context}]\n{message}\n\n");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Could not open the log file: {e}"))?;
    file.write_all(entry.as_bytes())
        .map_err(|e| format!("Could not write to the log file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Launch VS Code targeted at `path` (i.e. `code /path/to/project`).
#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("The path \"{}\" no longer exists.", p.display()));
    }
    vscode_open(&[path])
}

/// Launch VS Code with one or more path args (`code <folder> [file]`).
fn vscode_open(args: &[String]) -> Result<(), String> {
    if let Ok(status) = make_command("code", args).status() {
        if status.success() {
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut open_args = vec!["-a".to_string(), "Visual Studio Code".to_string()];
        open_args.extend(args.iter().cloned());
        if let Ok(status) = Command::new("open").args(&open_args).status() {
            if status.success() {
                return Ok(());
            }
        }
    }

    Err("Could not open VS Code. Install the `code` command from VS Code (Command Palette → \"Shell Command: Install 'code' command in PATH\").".into())
}

/// Reveal `path` in the OS file manager (Finder / Explorer / file browser).
#[tauri::command]
fn open_in_file_manager(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("The path \"{}\" no longer exists.", p.display()));
    }

    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg(&path).status()
    } else if cfg!(target_os = "windows") {
        Command::new("explorer").arg(&path).status()
    } else {
        Command::new("xdg-open").arg(&path).status()
    };

    spawned.map_err(|e| format!("Could not open the folder: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(PreviewState::default())
        .manage(ClaudeState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            create_project,
            scan_projects,
            check_prerequisites,
            install_tool,
            delete_project,
            delete_project_permanently,
            write_generated_files,
            log_error,
            preview_status,
            install_deps,
            install_preview_requirement,
            start_preview,
            stop_preview,
            load_organization,
            save_organization,
            set_secret,
            get_secret,
            delete_secret,
            read_project_context,
            git_status,
            git_changes,
            git_remote,
            git_commit,
            git_push,
            git_fetch,
            git_pull,
            git_init,
            git_set_remote,
            git_log,
            git_clone,
            git_diff,
            git_remove_remote,
            git_refs,
            git_create_branch,
            git_checkout,
            git_delete_branch,
            git_stashes,
            git_stash_save,
            git_stash_apply,
            git_stash_drop,
            check_tool,
            run_claude_agent,
            stop_claude,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            read_dir,
            read_file_text,
            write_file_text,
            check_syntax,
            detect_endpoints,
            detect_api_calls,
            search_files,
            home_dir,
            open_in_editor,
            open_in_vscode,
            open_in_file_manager,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Kinetek application");
}
