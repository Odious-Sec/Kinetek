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
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

/// A project as rendered by a dashboard card. Serialized to camelCase so it
/// matches the TypeScript `Project` interface in `src/types.ts`.
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

/// Whether/how a project can be previewed (run locally).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    pub previewable: bool,
    /// "web" (dev server), "static" (index.html), or a non-previewable kind.
    pub kind: String,
    /// "node" | "static" | "none".
    pub runner: String,
    /// The npm script to run, if any (internal; harmless to the frontend).
    pub script: Option<String>,
    /// Node project missing its `node_modules`.
    pub needs_install: bool,
    pub node_installed: bool,
    pub message: String,
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_dir: None,
            default_editor: "vscode".into(),
            ai_provider: "gemini".into(),
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
    ]
}

fn find_tool(key: &str) -> Option<&'static ToolDef> {
    tool_catalog().iter().find(|t| t.key == key)
}

/// Which tools each template needs: `(tool_key, required)`.
fn template_prereqs(template_id: &str) -> Vec<(&'static str, bool)> {
    match template_id {
        "react-vite" | "vue-vite" | "svelte-vite" | "nextjs" | "node-express" => {
            vec![("node", true)]
        }
        "react-native" => {
            let mut v = vec![("node", true), ("android-studio", false)];
            // Xcode is only relevant (and detectable) on macOS.
            if cfg!(target_os = "macos") {
                v.push(("xcode", false));
            }
            v
        }
        "aspnet-core" => vec![("dotnet", true)],
        "python-fastapi" => vec![("python", true)],
        "rust-cli" => vec![("cargo", true)],
        "go-module" => vec![("go", true)],
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
        "react-vite" => vite("react-ts"),
        "vue-vite" => vite("vue-ts"),
        "svelte-vite" => vite("svelte-ts"),

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

        // npx --yes create-expo-app@latest <name>
        "react-native" => Scaffold::Cli {
            program: "npx",
            args: vec![
                "--yes".into(),
                "create-expo-app@latest".into(),
                name.into(),
            ],
        },

        // dotnet new webapi -o <name>
        "aspnet-core" => Scaffold::Cli {
            program: "dotnet",
            args: vec!["new".into(), "webapi".into(), "-o".into(), name.into()],
        },

        // cargo new <name>
        "rust-cli" => Scaffold::Cli {
            program: "cargo",
            args: vec!["new".into(), name.into()],
        },

        // File-based templates (work offline, no required CLI to scaffold).
        "node-express" => Scaffold::Files(node_express_files(name)),
        "python-fastapi" => Scaffold::Files(python_fastapi_files(name)),
        "go-module" => Scaffold::Files(go_module_files(name)),
        "static-web" => Scaffold::Files(static_web_files(name)),

        other => return Err(format!("Unknown template: \"{other}\".")),
    };
    Ok(scaffold)
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

fn create_project_inner(
    app: tauri::AppHandle,
    parent_dir: String,
    project_name: String,
    template_id: String,
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

    let project_path = parent.join(name);
    if project_path.exists() {
        return Err(format!(
            "A folder named \"{name}\" already exists at that location."
        ));
    }

    match scaffold_for(&template_id, name)? {
        Scaffold::Cli { program, args } => {
            // Echo the command, then stream its output live to the UI.
            let _ = app.emit(
                "project-output",
                OutputLine {
                    line: format!("$ {} {}", program, args.join(" ")),
                    stream: "stdout".into(),
                },
            );

            // CI=1 + a null stdin keep scaffolders non-interactive: any prompt
            // reads EOF and the tool exits with an error instead of hanging.
            let mut child = make_command(program, &args)
                .current_dir(&parent)
                .env("CI", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| {
                    format!(
                        "Could not run `{program}`: {e}\n\nMake sure {program} is installed and available on your PATH."
                    )
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
                let detail = collected
                    .lock()
                    .map(|v| v.join("\n"))
                    .unwrap_or_default();
                let detail = detail.trim();
                return Err(format!(
                    "`{program}` exited with an error:\n\n{}",
                    if detail.is_empty() { "(no output)" } else { detail }
                ));
            }
        }
        Scaffold::Files(files) => {
            fs::create_dir_all(&project_path)
                .map_err(|e| format!("Could not create the project folder: {e}"))?;
            for (rel, contents) in files {
                let target = project_path.join(rel);
                if let Some(dir) = target.parent() {
                    fs::create_dir_all(dir)
                        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
                }
                fs::write(&target, contents)
                    .map_err(|e| format!("Could not write {}: {e}", target.display()))?;
                let _ = app.emit(
                    "project-output",
                    OutputLine {
                        line: format!("Created {rel}"),
                        stream: "stdout".into(),
                    },
                );
            }
        }
    }

    Ok(ProjectInfo {
        id: project_path.to_string_lossy().to_string(),
        name: name.to_string(),
        path: project_path.to_string_lossy().to_string(),
        summary,
        status,
        frameworks,
        has_preview: true,
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
fn preview_plan(path: &Path) -> PreviewStatus {
    let node_installed = tool_present("node", &["--version"]).is_some();

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
            Some(s) => PreviewStatus {
                previewable: true,
                kind: "web".into(),
                runner: "node".into(),
                script: Some(s),
                needs_install: !path.join("node_modules").exists(),
                node_installed,
                message: String::new(),
            },
            None => PreviewStatus {
                previewable: false,
                kind: "node".into(),
                runner: "node".into(),
                script: None,
                needs_install: false,
                node_installed,
                message: "This project has no \"dev\", \"start\" or \"serve\" script to preview.".into(),
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
            node_installed,
            message: String::new(),
        };
    }

    PreviewStatus {
        previewable: false,
        kind: "unknown".into(),
        runner: "none".into(),
        script: None,
        needs_install: false,
        node_installed,
        message: "Preview supports web projects — a Node dev server or a static site. This project type isn't previewable yet.".into(),
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

/// Start the dev server (or resolve a static URL). Returns the preview id, the
/// URL to load, and the child process to track (None for static sites).
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

    if plan.kind == "static" {
        let index = path.join("index.html");
        let url = format!("file://{}", index.to_string_lossy());
        return Ok((id, url, None));
    }

    // Node dev server.
    if !plan.node_installed {
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

/// Bootstrap a new project from a template by running its framework CLI.
#[tauri::command]
async fn create_project(
    app: tauri::AppHandle,
    parent_dir: String,
    project_name: String,
    template_id: String,
    summary: String,
    status: String,
    frameworks: Vec<String>,
) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_project_inner(
            app,
            parent_dir,
            project_name,
            template_id,
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
                node_installed: false,
                message: "That folder no longer exists.".into(),
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

        // "<ahead> <behind>" relative to the upstream (if one is configured).
        let (ahead, behind) = run(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])
            .map(|s| {
                let mut it = s.split_whitespace();
                let a = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                let b = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
                (a, b)
            })
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
        })
    })
    .await
    .map_err(|e| format!("The clone task failed unexpectedly: {e}"))?
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

fn launch_cli_editor(cli: &str, mac_app: &str, path: &str) -> Result<(), String> {
    if let Ok(status) = make_command(cli, &[path.to_string()]).status() {
        if status.success() {
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(status) = Command::new("open").args(["-a", mac_app, path]).status() {
            if status.success() {
                return Ok(());
            }
        }
    }
    Err(format!(
        "Could not open {mac_app}. Make sure it's installed and on your PATH."
    ))
}

/// Open a project in the user's chosen editor.
#[tauri::command]
fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("The path \"{}\" no longer exists.", p.display()));
    }
    match editor.as_str() {
        "vscode" => open_in_vscode(path),
        "cursor" => launch_cli_editor("cursor", "Cursor", &path),
        "zed" => launch_cli_editor("zed", "Zed", &path),
        "finder" => open_in_file_manager(path),
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

    if let Ok(status) = make_command("code", &[path.clone()]).status() {
        if status.success() {
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(status) = Command::new("open")
            .args(["-a", "Visual Studio Code", &path])
            .status()
        {
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
            git_init,
            git_set_remote,
            git_log,
            git_clone,
            read_dir,
            read_file_text,
            search_files,
            home_dir,
            open_in_editor,
            open_in_vscode,
            open_in_file_manager,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Kinetek application");
}
