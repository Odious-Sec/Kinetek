import { useEffect, useState } from "react";
import type { Settings } from "../types";
import { AI_PROVIDERS, secretKeyFor } from "../lib/ai";
import {
  deleteSecret,
  getSecret,
  openUrl,
  pickDirectory,
  setSecret,
} from "../lib/tauri";
import Field from "./Field";
import {
  CheckIcon,
  ExternalLinkIcon,
  FolderIcon,
  KeyIcon,
  XIcon,
} from "./icons";

const EDITORS = [
  { id: "vscode", name: "VS Code" },
  { id: "cursor", name: "Cursor" },
  { id: "zed", name: "Zed" },
  { id: "finder", name: "File manager" },
];

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

export default function SettingsDialog({ settings, onSave, onClose, notify }: Props) {
  const [defaultDir, setDefaultDir] = useState(settings.defaultDir ?? "");
  const [defaultEditor, setDefaultEditor] = useState(settings.defaultEditor);
  const [aiProvider, setAiProvider] = useState(settings.aiProvider);
  const [apiKey, setApiKey] = useState("");
  const [keyExists, setKeyExists] = useState(false);
  const [busy, setBusy] = useState(false);

  const provider =
    AI_PROVIDERS.find((p) => p.id === aiProvider) ?? AI_PROVIDERS[0];

  // Reflect whether a key is already stored for the selected provider.
  useEffect(() => {
    let cancelled = false;
    setApiKey("");
    getSecret(secretKeyFor(aiProvider))
      .then((v) => {
        if (!cancelled) setKeyExists(!!v);
      })
      .catch(() => {
        if (!cancelled) setKeyExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aiProvider]);

  async function handleBrowse() {
    const dir = await pickDirectory("Choose a default location for new projects");
    if (dir) setDefaultDir(dir);
  }

  async function handleSave() {
    setBusy(true);
    try {
      if (apiKey.trim()) {
        await setSecret(secretKeyFor(aiProvider), apiKey.trim());
        setKeyExists(true);
        setApiKey("");
      }
      onSave({
        defaultDir: defaultDir.trim() || null,
        defaultEditor,
        aiProvider,
      });
      notify("ok", "Settings saved.");
      onClose();
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveKey() {
    setBusy(true);
    try {
      await deleteSecret(secretKeyFor(aiProvider));
      setKeyExists(false);
      setApiKey("");
      notify("ok", `Removed the ${provider.name} key.`);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface-raised shadow-glow animate-scale-in">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-100">Settings</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-surface-hover hover:text-slate-200"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {/* Default location */}
          <Field label="Default location for new projects">
            <div className="flex gap-2">
              <input
                value={defaultDir}
                onChange={(e) => setDefaultDir(e.target.value)}
                placeholder="Used to prefill the New Project wizard"
                spellCheck={false}
                className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60"
              />
              <button
                onClick={handleBrowse}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover"
              >
                <FolderIcon className="h-4 w-4" />
                Browse
              </button>
            </div>
          </Field>

          {/* Default editor */}
          <Field label="Open projects in">
            <div className="flex flex-wrap gap-2">
              {EDITORS.map((ed) => (
                <button
                  key={ed.id}
                  onClick={() => setDefaultEditor(ed.id)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                    defaultEditor === ed.id
                      ? "border-accent/60 bg-accent/15 text-accent-soft"
                      : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
                  }`}
                >
                  {ed.name}
                </button>
              ))}
            </div>
          </Field>

          {/* AI provider */}
          <Field label="AI provider">
            <div className="flex flex-wrap gap-2">
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setAiProvider(p.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                    aiProvider === p.id
                      ? "border-accent/60 bg-accent/15 text-accent-soft"
                      : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
                  }`}
                >
                  {p.name}
                  {p.free && (
                    <span className="rounded bg-emerald-400/15 px-1 py-0.5 text-[10px] font-semibold text-emerald-300">
                      Free
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Field>

          {/* API key (keychain) */}
          <Field
            label={`${provider.name} API key`}
            hint={
              keyExists
                ? "A key is saved in your OS keychain. Type a new one to replace it."
                : "Stored securely in your OS keychain — never in plain text."
            }
          >
            <div className="flex items-center gap-2">
              <span className="text-slate-500">
                <KeyIcon className="h-4 w-4" />
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyExists ? "•••••••••• (saved)" : "Paste your key…"}
                spellCheck={false}
                className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-600 focus:border-accent/60"
              />
              {keyExists && (
                <button
                  onClick={handleRemoveKey}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            <button
              onClick={() => openUrl(provider.keyUrl)}
              className="mt-1.5 inline-flex items-center gap-0.5 text-[11px] text-accent-soft hover:underline"
            >
              Get a {provider.name} key <ExternalLinkIcon className="h-3 w-3" />
            </button>
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-5 py-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-surface-border bg-surface-card px-3.5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:opacity-50"
          >
            <CheckIcon className="h-4 w-4" />
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
