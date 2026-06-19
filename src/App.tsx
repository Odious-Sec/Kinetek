import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { Folder, Project, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import TitleBar from "./components/TitleBar";
import Dashboard from "./components/Dashboard";
import DashboardHome from "./components/DashboardHome";
import Sidebar, { type FolderSelection, type ViewMode } from "./components/Sidebar";
import Explorer from "./components/Explorer";
import GithubPage from "./components/GithubPage";
import ProjectPage from "./components/ProjectPage";
import ProjectWizard from "./components/ProjectWizard";
import PreviewDialog from "./components/PreviewDialog";
import Onboarding from "./components/Onboarding";
import ConfirmDialog from "./components/ConfirmDialog";
import EditProjectDialog from "./components/EditProjectDialog";
import SettingsDialog from "./components/SettingsDialog";
import LogConsole from "./components/LogConsole";
import { AlertIcon, CheckIcon, XIcon } from "./components/icons";
import { AI_PROVIDERS, secretKeyFor } from "./lib/ai";
import { explainProject } from "./lib/generate";
import {
  GITHUB_TOKEN_KEY,
  deleteProject,
  deleteProjectPermanently,
  deleteSecret,
  getSecret,
  isTauri,
  loadOrganization,
  logError,
  logInfo,
  openInEditor,
  openInFileManager,
  pickDirectory,
  readProjectContext,
  saveOrganization,
  scanProjects,
} from "./lib/tauri";
import { SAMPLE_PROJECTS } from "./lib/sampleData";

// xterm is heavy — only load it when the Terminal page is opened.
const TerminalView = lazy(() => import("./components/TerminalView"));

type Toast = { id: number; kind: "ok" | "err"; message: string };

export default function App() {
  const [projects, setProjects] = useState<Project[]>(SAMPLE_PROJECTS);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [previewProject, setPreviewProject] = useState<Project | null>(null);

  // In-app organization (virtual folders + project→folder assignments).
  const [folders, setFolders] = useState<Folder[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [selectedFolder, setSelectedFolder] = useState<FolderSelection>("all");
  const [view, setView] = useState<ViewMode>("home");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [orgLoaded, setOrgLoaded] = useState(false);

  // Editing + settings + AI.
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  // Full-page project view (id so it tracks edits/deletes).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [explainingId, setExplainingId] = useState<string | null>(null);

  // Load the saved workspace once on startup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const org = await loadOrganization();
        if (cancelled) return;
        // In the desktop app the persisted list is the source of truth;
        // in a plain browser keep the sample data.
        if (isTauri()) setProjects(org.projects ?? []);
        setFolders(org.folders ?? []);
        setAssignments(org.assignments ?? {});
        setSettings(org.settings ?? DEFAULT_SETTINGS);
      } catch {
        /* fall back to defaults */
      } finally {
        if (!cancelled) setOrgLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the whole workspace after the initial load.
  useEffect(() => {
    if (!orgLoaded) return;
    void saveOrganization({ projects, folders, assignments, settings });
  }, [projects, folders, assignments, settings, orgLoaded]);

  const sidebarCounts = useMemo(() => {
    const byFolder: Record<string, number> = {};
    let unfiled = 0;
    for (const p of projects) {
      const fid = assignments[p.id];
      if (fid && folders.some((f) => f.id === fid)) {
        byFolder[fid] = (byFolder[fid] ?? 0) + 1;
      } else {
        unfiled += 1;
      }
    }
    return { all: projects.length, unfiled, byFolder };
  }, [projects, assignments, folders]);

  const createFolder = useCallback((name: string) => {
    const id = `f-${Date.now().toString(36)}`;
    setFolders((prev) => [...prev, { id, name }]);
    setSelectedFolder(id);
  }, []);

  const renameFolder = useCallback((id: string, name: string) => {
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  }, []);

  const deleteFolder = useCallback(
    (folder: Folder) => {
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setAssignments((prev) => {
        const next: Record<string, string> = {};
        for (const [pid, fid] of Object.entries(prev)) {
          if (fid !== folder.id) next[pid] = fid;
        }
        return next;
      });
      setSelectedFolder((cur) => (cur === folder.id ? "all" : cur));
    },
    []
  );

  const assignFolder = useCallback(
    (project: Project, folderId: string | null) => {
      setAssignments((prev) => {
        const next = { ...prev };
        if (folderId) next[project.id] = folderId;
        else delete next[project.id];
        return next;
      });
    },
    []
  );

  // Drop an assignment when its project is removed from the dashboard.
  const forgetAssignment = useCallback((projectId: string) => {
    setAssignments((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  const notify = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
    if (kind === "err") logError("app", message);
    else logInfo("app", message);
  }, []);

  const handleScanFolder = useCallback(async () => {
    if (!isTauri()) {
      notify("err", "Folder scanning is only available in the desktop app.");
      return;
    }
    const dir = await pickDirectory("Choose a folder of projects to scan");
    if (!dir) return;
    setScanning(true);
    try {
      const found = await scanProjects(dir);
      // Merge by path, keeping any existing cards' custom metadata.
      setProjects((prev) => {
        // Keep existing cards (and their edits); only add newly-found ones.
        const byId = new Map(prev.map((p) => [p.id, p]));
        for (const p of found) {
          if (!byId.has(p.id)) byId.set(p.id, p);
        }
        return Array.from(byId.values());
      });
      notify("ok", `Found ${found.length} project${found.length === 1 ? "" : "s"}.`);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setScanning(false);
    }
  }, [notify]);

  const handleProceedToCode = useCallback(
    async (project: Project) => {
      if (!isTauri()) {
        notify("err", "Opening an editor is only available in the desktop app.");
        return;
      }
      try {
        await openInEditor(project.path, settings.defaultEditor);
        notify("ok", `Opening ${project.name}…`);
      } catch (e) {
        const msg = typeof e === "string" ? e : String(e);
        notify("err", msg);
      }
    },
    [notify, settings.defaultEditor]
  );

  // Open a folder (project root or a part) in the editor, optionally focusing a
  // file — so "open this file" opens its part as the workspace with the file open.
  const handleOpenPath = useCallback(
    async (path: string, file?: string) => {
      if (!isTauri()) {
        notify("err", "Opening an editor is only available in the desktop app.");
        return;
      }
      try {
        await openInEditor(path, settings.defaultEditor, file);
        notify("ok", `Opening in ${settings.defaultEditor}…`);
      } catch (e) {
        notify("err", typeof e === "string" ? e : String(e));
      }
    },
    [notify, settings.defaultEditor]
  );

  // Wipe everything stored on this device: the saved workspace (projects,
  // folders, settings) and all secrets (AI keys + GitHub token), then return to
  // first-run setup.
  const handleReset = useCallback(async () => {
    if (isTauri()) {
      await Promise.all([
        ...AI_PROVIDERS.map((p) => deleteSecret(secretKeyFor(p.id)).catch(() => {})),
        deleteSecret(GITHUB_TOKEN_KEY).catch(() => {}),
      ]);
    }
    setProjects(isTauri() ? [] : SAMPLE_PROJECTS);
    setFolders([]);
    setAssignments({});
    setSelectedFolder("all");
    setExpandedId(null);
    setView("home");
    setSettingsOpen(false);
    setSettings({ ...DEFAULT_SETTINGS, onboarded: false });
    notify("ok", "Kinetek has been reset to first-run.");
  }, [notify]);

  const handleReveal = useCallback(
    async (project: Project) => {
      if (!isTauri()) return;
      try {
        await openInFileManager(project.path);
      } catch (e) {
        notify("err", typeof e === "string" ? e : String(e));
      }
    },
    [notify]
  );

  // Open the unified preview dialog (checks requirements, installs, runs).
  const handlePreview = useCallback(
    (project: Project) => {
      if (!isTauri()) {
        notify("err", "Preview is only available in the desktop app.");
        return;
      }
      setPreviewProject(project);
    },
    [notify]
  );

  const handleCreated = useCallback((project: Project) => {
    setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
  }, []);

  const handleSaveEdit = useCallback((updated: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setEditingProject(null);
  }, []);

  // AI "Explain this project": summarize the repo into a plain-English card.
  const handleExplain = useCallback(
    async (project: Project) => {
      if (!isTauri()) {
        notify("err", "AI explain is only available in the desktop app.");
        return;
      }
      const provider =
        AI_PROVIDERS.find((p) => p.id === settings.aiProvider) ?? AI_PROVIDERS[0];
      const key = await getSecret(secretKeyFor(provider.id)).catch(() => null);
      if (!key) {
        notify(
          "err",
          `Add your ${provider.name} API key in Settings (gear, top-right) to use AI.`
        );
        return;
      }
      setExplainingId(project.id);
      try {
        const context = await readProjectContext(project.path);
        const exp = await explainProject(provider, key, context);
        setProjects((prev) =>
          prev.map((p) =>
            p.id === project.id
              ? {
                  ...p,
                  summary: exp.summary || p.summary,
                  status: exp.status,
                  frameworks: exp.tags.length ? exp.tags : p.frameworks,
                }
              : p
          )
        );
        notify("ok", `Updated ${project.name} from AI.`);
      } catch (e) {
        const msg = typeof e === "string" ? e : String(e);
        notify("err", msg);
        logError(`explain:${provider.id}`, msg);
      } finally {
        setExplainingId(null);
      }
    },
    [notify, settings.aiProvider]
  );

  // Sample (browser) cards have placeholder paths, so deleting them just
  // removes the card; real cards are moved to the Trash on disk.
  const requestDelete = useCallback((project: Project) => {
    setDeleteError("");
    setPendingDelete(project);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const project = pendingDelete;
    const isSample = project.id.startsWith("sample-");
    if (!isTauri() || isSample) {
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      forgetAssignment(project.id);
      setPendingDelete(null);
      notify("ok", `Removed ${project.name} from the dashboard.`);
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteProject(project.path);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      forgetAssignment(project.id);
      notify("ok", `Moved ${project.name} to the Trash.`);
      setPendingDelete(null);
    } catch (e) {
      // Keep the dialog open and offer the permanent-delete fallback.
      const msg = typeof e === "string" ? e : String(e);
      setDeleteError(msg);
      logError("delete:trash", msg);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, notify]);

  const handleDeletePermanently = useCallback(async () => {
    if (!pendingDelete) return;
    const project = pendingDelete;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteProjectPermanently(project.path);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      forgetAssignment(project.id);
      notify("ok", `Permanently deleted ${project.name}.`);
      setPendingDelete(null);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setDeleteError(msg);
      logError("delete:permanent", msg);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, notify]);

  // Live version of the full-page (expanded) project — refreshes on edit,
  // clears on delete. Selecting a project anywhere opens this page directly.
  const expanded = expandedId
    ? projects.find((p) => p.id === expandedId) ?? null
    : null;

  // First-run setup (desktop only; wait for the load so it doesn't flash).
  const needsOnboarding = isTauri() && orgLoaded && !settings.onboarded;

  // Folder names already on disk, so the GitHub page can mark repos as "saved".
  const localNames = useMemo(
    () =>
      new Set(
        projects
          .filter((p) => !p.id.startsWith("sample-"))
          .map((p) => p.path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? p.name)
      ),
    [projects]
  );

  return (
    <div className="flex h-full flex-col bg-surface-base">
      <TitleBar onOpenSettings={() => setSettingsOpen(true)} />

      <div className="flex min-h-0 flex-1">
        {needsOnboarding ? (
          <Onboarding settings={settings} onComplete={setSettings} notify={notify} />
        ) : expanded ? (
          <ProjectPage
            project={expanded}
            onBack={() => {
              setExpandedId(null);
              setView("projects");
            }}
            onOpenPath={handleOpenPath}
            onPreview={setPreviewProject}
            notify={notify}
          />
        ) : (
          <>
            <Sidebar
              view={view}
              onView={setView}
              folders={folders}
              counts={sidebarCounts}
              selected={selectedFolder}
              onSelect={setSelectedFolder}
              onCreate={createFolder}
              onRename={renameFolder}
              onDelete={deleteFolder}
            />
            <div className="min-h-0 min-w-0 flex-1">
              {view === "home" ? (
                <DashboardHome
                  projects={projects}
                  onNewProject={() => setWizardOpen(true)}
                  onScanFolder={handleScanFolder}
                  onOpenGithub={() => setView("github")}
                  onOpenExplorer={() => setView("explorer")}
                  onOpenProjects={() => setView("projects")}
                  onOpenProject={(p) => setExpandedId(p.id)}
                />
              ) : view === "explorer" ? (
                <Explorer initialRoot={settings.defaultDir ?? ""} notify={notify} />
              ) : view === "terminal" ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-slate-600">
                      Loading terminal…
                    </div>
                  }
                >
                  <TerminalView cwd={settings.defaultDir ?? ""} />
                </Suspense>
              ) : view === "github" ? (
                <GithubPage
                  notify={notify}
                  defaultDir={settings.defaultDir}
                  localNames={localNames}
                  onCloned={handleCreated}
                />
              ) : (
                <Dashboard
                  projects={projects}
                  scanning={scanning}
                  narrow={false}
                  folders={folders}
                  assignments={assignments}
                  selectedFolder={selectedFolder}
                  explainingId={explainingId}
                  onNewProject={() => setWizardOpen(true)}
                  onScanFolder={handleScanFolder}
                  onProceedToCode={handleProceedToCode}
                  onPreview={handlePreview}
                  onReveal={handleReveal}
                  onDelete={requestDelete}
                  onAssignFolder={assignFolder}
                  onEdit={setEditingProject}
                  onExplain={handleExplain}
                  onSelect={(p) => setExpandedId(p.id)}
                />
              )}
            </div>
          </>
        )}
      </div>

      {wizardOpen && (
        <ProjectWizard
          defaultDir={settings.defaultDir ?? ""}
          onClose={() => setWizardOpen(false)}
          onCreated={handleCreated}
          onOpenInCode={(p) => {
            handleProceedToCode(p);
            setWizardOpen(false);
          }}
        />
      )}

      {editingProject && (
        <EditProjectDialog
          project={editingProject}
          onSave={handleSaveEdit}
          onCancel={() => setEditingProject(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onSave={setSettings}
          onClose={() => setSettingsOpen(false)}
          onReset={handleReset}
          notify={notify}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.name}?`}
          message={
            isTauri() && !pendingDelete.id.startsWith("sample-")
              ? "This moves the project folder to your Trash. You can restore it from there if you change your mind."
              : "This removes the project from your dashboard."
          }
          detail={pendingDelete.path}
          confirmLabel={
            isTauri() && !pendingDelete.id.startsWith("sample-")
              ? "Move to Trash"
              : "Remove"
          }
          destructive
          busy={deleting}
          error={deleteError || undefined}
          secondaryLabel={
            deleteError &&
            isTauri() &&
            !pendingDelete.id.startsWith("sample-")
              ? "Delete permanently"
              : undefined
          }
          onSecondary={
            deleteError ? handleDeletePermanently : undefined
          }
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            if (deleting) return;
            setPendingDelete(null);
            setDeleteError("");
          }}
        />
      )}

      {previewProject && (
        <PreviewDialog
          project={previewProject}
          onClose={() => setPreviewProject(null)}
          notify={notify}
        />
      )}

      {/* Live, real-time error & activity console */}
      <LogConsole />

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl border border-surface-border bg-surface-raised px-3.5 py-3 text-sm shadow-glow animate-fade-in"
          >
            <span
              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                t.kind === "ok"
                  ? "bg-emerald-400/15 text-emerald-300"
                  : "bg-rose-500/15 text-rose-300"
              }`}
            >
              {t.kind === "ok" ? (
                <CheckIcon className="h-3 w-3" />
              ) : (
                <AlertIcon className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="flex-1 text-slate-200">{t.message}</span>
            <button
              onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
              className="text-slate-500 transition-colors hover:text-slate-300"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
