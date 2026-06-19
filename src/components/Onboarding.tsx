import { useEffect, useState } from "react";
import type { Settings } from "../types";
import { AI_PROVIDERS, secretKeyFor } from "../lib/ai";
import { getGithubUser } from "../lib/github";
import {
  GITHUB_TOKEN_KEY,
  checkTool,
  isTauri,
  openUrl,
  pickDirectory,
  setSecret,
} from "../lib/tauri";
import Field from "./Field";
import {
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  FolderIcon,
  GithubIcon,
  KeyIcon,
  LockIcon,
  RefreshIcon,
  SparkIcon,
} from "./icons";

const EDITORS = [
  { id: "vscode", name: "VS Code" },
  { id: "cursor", name: "Cursor" },
  { id: "zed", name: "Zed" },
  { id: "finder", name: "File manager" },
];

interface Props {
  settings: Settings;
  onComplete: (settings: Settings) => void;
  notify: (kind: "ok" | "err", message: string) => void;
}

/**
 * First-run configuration. Walks a new user through their AI key, Claude Code,
 * GitHub connection, and workspace defaults — and makes the privacy model
 * explicit: everything stays on this device. Every step is optional.
 */
export default function Onboarding({ settings, onComplete, notify }: Props) {
  const [aiProvider, setAiProvider] = useState(settings.aiProvider);
  const [apiKey, setApiKey] = useState("");

  const [githubToken, setGithubToken] = useState("");
  const [ghUser, setGhUser] = useState<null | "loading" | "invalid" | string>(null);

  const [defaultDir, setDefaultDir] = useState(settings.defaultDir ?? "");
  const [defaultEditor, setDefaultEditor] = useState(settings.defaultEditor);

  const [claudeFound, setClaudeFound] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const provider = AI_PROVIDERS.find((p) => p.id === aiProvider) ?? AI_PROVIDERS[0];

  useEffect(() => {
    if (!isTauri()) return;
    checkTool("claude")
      .then((t) => setClaudeFound(t.installed))
      .catch(() => setClaudeFound(false));
  }, []);

  async function connectGithub() {
    const t = githubToken.trim();
    if (!t) return;
    setGhUser("loading");
    try {
      const u = await getGithubUser(t);
      await setSecret(GITHUB_TOKEN_KEY, t);
      setGhUser(u.login);
      notify("ok", `Connected GitHub as @${u.login}.`);
    } catch {
      setGhUser("invalid");
    }
  }

  async function finish() {
    setSaving(true);
    try {
      if (isTauri() && apiKey.trim()) {
        await setSecret(secretKeyFor(aiProvider), apiKey.trim()).catch(() => {});
      }
      // GitHub token is saved when "Connect" succeeds; save it here too if the
      // user pasted one but didn't press Connect.
      if (isTauri() && githubToken.trim() && ghUser === null) {
        await setSecret(GITHUB_TOKEN_KEY, githubToken.trim()).catch(() => {});
      }
    } finally {
      setSaving(false);
      onComplete({
        ...settings,
        aiProvider,
        defaultEditor,
        defaultDir: defaultDir.trim() || null,
        onboarded: true,
      });
    }
  }

  return (
    <div className="h-full overflow-auto bg-surface-base">
      <div className="mx-auto max-w-2xl px-6 py-10">
        {/* Welcome */}
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/20 text-accent-soft">
            <SparkIcon className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Welcome to Kinetek</h1>
            <p className="text-sm text-slate-500">A couple of optional steps and you're set.</p>
          </div>
        </div>

        {/* Privacy / offline statement */}
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-400/15 text-emerald-300">
            <LockIcon className="h-4 w-4" />
          </span>
          <div className="text-sm leading-relaxed text-slate-300">
            <p className="font-medium text-slate-100">Everything stays on this device.</p>
            <p className="mt-1 text-slate-400">
              Kinetek is offline-first. It has no account, no cloud, and no telemetry — your
              projects never leave your machine. API keys and tokens are stored in your{" "}
              <span className="text-slate-300">OS keychain</span>; preferences live in a local
              file. Keys are only ever sent directly to the provider you choose (e.g. your AI or
              GitHub), never to us.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* AI provider */}
          <Section icon={<SparkIcon className="h-4 w-4" />} title="AI provider (bring your own key)" hint="Powers project generation & explanations. Optional — add later in Settings.">
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
            <div className="mt-2 flex items-center gap-2">
              <KeyIcon className="h-4 w-4 shrink-0 text-slate-500" />
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`${provider.name} API key (optional)`}
                spellCheck={false}
                className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent/60"
              />
            </div>
            <button
              onClick={() => openUrl(provider.keyUrl)}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-accent-soft hover:underline"
            >
              {provider.note} — get a key <ExternalLinkIcon className="h-3 w-3" />
            </button>
          </Section>

          {/* Claude Code */}
          <Section icon={<BotIcon className="h-4 w-4" />} title="Claude Code (optional)" hint="Agentic coding inside Kinetek. Uses your own Claude sign-in — no key stored here.">
            {claudeFound === null ? (
              <p className="text-xs text-slate-500">Checking…</p>
            ) : claudeFound ? (
              <p className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
                <CheckIcon className="h-3.5 w-3.5" /> Claude Code CLI detected.
              </p>
            ) : (
              <div className="text-xs text-slate-400">
                Not installed. Install the CLI, then sign in once:
                <code className="ml-1 rounded bg-surface-card px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                  npm i -g @anthropic-ai/claude-code
                </code>
                <button
                  onClick={() => openUrl("https://docs.anthropic.com/en/docs/claude-code/setup")}
                  className="ml-2 inline-flex items-center gap-1 text-accent-soft hover:underline"
                >
                  Setup <ExternalLinkIcon className="h-3 w-3" />
                </button>
              </div>
            )}
          </Section>

          {/* GitHub */}
          <Section icon={<GithubIcon className="h-4 w-4" />} title="GitHub (optional)" hint="Browse, clone, commit, and push. Needs a classic token with the repo scope.">
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={githubToken}
                onChange={(e) => {
                  setGithubToken(e.target.value);
                  setGhUser(null);
                }}
                placeholder="GitHub personal access token (classic)"
                spellCheck={false}
                className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent/60"
              />
              <button
                onClick={connectGithub}
                disabled={!githubToken.trim() || ghUser === "loading"}
                className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-glow disabled:opacity-40"
              >
                {ghUser === "loading" ? "…" : "Connect"}
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <button
                onClick={() => openUrl("https://github.com/settings/tokens/new?scopes=repo&description=Kinetek")}
                className="inline-flex items-center gap-1 text-[11px] text-accent-soft hover:underline"
              >
                Create a classic token (tick <code>repo</code>) <ExternalLinkIcon className="h-3 w-3" />
              </button>
              {ghUser && ghUser !== "loading" && (
                <span className={`text-[11px] ${ghUser === "invalid" ? "text-rose-300" : "text-emerald-300"}`}>
                  {ghUser === "invalid" ? "Token rejected" : `Connected as @${ghUser}`}
                </span>
              )}
            </div>
          </Section>

          {/* Workspace */}
          <Section icon={<FolderIcon className="h-4 w-4" />} title="Workspace defaults" hint="Where new projects go, and which editor 'Proceed to IDE' opens.">
            <Field label="Default location">
              <div className="flex gap-2">
                <input
                  value={defaultDir}
                  onChange={(e) => setDefaultDir(e.target.value)}
                  placeholder={isTauri() ? "Choose a folder…" : "~/Developer"}
                  spellCheck={false}
                  className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-accent/60"
                />
                <button
                  onClick={async () => {
                    const d = await pickDirectory("Choose your default projects folder");
                    if (d) setDefaultDir(d);
                  }}
                  disabled={!isTauri()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-surface-border bg-surface-card px-3 py-2 text-xs font-medium text-slate-200 hover:bg-surface-hover disabled:opacity-40"
                >
                  <FolderIcon className="h-3.5 w-3.5" /> Browse
                </button>
              </div>
            </Field>
            <Field label="Default editor">
              <div className="flex flex-wrap gap-2">
                {EDITORS.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setDefaultEditor(e.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                      defaultEditor === e.id
                        ? "border-accent/60 bg-accent/15 text-accent-soft"
                        : "border-surface-border bg-surface-card text-slate-300 hover:bg-surface-hover"
                    }`}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            </Field>
          </Section>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => onComplete({ ...settings, onboarded: true })}
            className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-300"
          >
            Skip for now
          </button>
          <button
            onClick={finish}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-glow disabled:opacity-50"
          >
            {saving ? <RefreshIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
            Finish setup
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-surface-border bg-surface-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-accent-soft">{icon}</span>
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      </div>
      <p className="mb-3 text-xs text-slate-500">{hint}</p>
      {children}
    </section>
  );
}
