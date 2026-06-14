import { fetch } from "@tauri-apps/plugin-http";
import type {
  AiProvider,
  GeneratedFile,
  ProjectContext,
  ProjectStatus,
} from "../types";
import { PROJECT_STATUSES } from "../types";

/**
 * AI generation for the "Build by goal" flow and "Explain this project".
 *
 * All requests go through Tauri's HTTP plugin (executed in Rust), so they
 * bypass webview CORS/CSP. The user's key is passed per-call. Three request
 * shapes are supported:
 *   - Gemini: generateContent API (responseMimeType JSON, optional schema)
 *   - Groq / OpenAI / OpenRouter: OpenAI-compatible chat/completions (JSON mode)
 *   - Claude: Anthropic Messages API
 *
 * Every provider is driven by a prompt that fully specifies the JSON shape, so
 * providers without schema enforcement still return parseable output.
 */

/** Providers with a working implementation. */
export const IMPLEMENTED_PROVIDERS = new Set([
  "gemini",
  "groq",
  "openrouter",
  "claude",
  "openai",
]);

const GEMINI_MODEL = "gemini-2.0-flash";
const CLAUDE_MODEL = "claude-opus-4-8";

/** OpenAI-compatible providers (same chat/completions wire format). */
const OPENAI_COMPATIBLE: Record<string, { url: string; model: string }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o-mini",
  },
};

// ---------------------------------------------------------------------------
// Shared HTTP + JSON helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
async function httpJson(
  url: string,
  init: Parameters<typeof fetch>[1],
  providerName: string
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(
      `Could not reach ${providerName}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j: any = await res.json();
      detail =
        (typeof j?.error?.message === "string" && j.error.message) ||
        (typeof j?.error === "string" && j.error) ||
        (typeof j?.message === "string" && j.message) ||
        "";
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${providerName} rejected the API key (HTTP ${res.status}). Check it in Settings.`
      );
    }
    throw new Error(
      `${providerName} request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`
    );
  }
  return res.json();
}

/** Parse JSON, tolerating stray prose around the object. */
function parseJsonLoose(text: string, providerName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* try to extract the object */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error(`${providerName} returned malformed JSON.`);
}

// ---------------------------------------------------------------------------
// Per-provider callers (each returns a parsed JSON object)
// ---------------------------------------------------------------------------

async function geminiJson(
  apiKey: string,
  prompt: string,
  responseSchema?: unknown
): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  const generationConfig: any = {
    temperature: 0.4,
    responseMimeType: "application/json",
  };
  if (responseSchema) generationConfig.responseSchema = responseSchema;

  const data = await httpJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
      }),
    },
    "Gemini"
  );

  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) throw new Error(`Gemini blocked the request (${blocked}).`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  return parseJsonLoose(text, "Gemini");
}

async function openAICompatibleJson(
  providerId: string,
  providerName: string,
  apiKey: string,
  prompt: string
): Promise<unknown> {
  const cfg = OPENAI_COMPATIBLE[providerId];
  const data = await httpJson(
    cfg.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    },
    providerName
  );

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${providerName} returned an empty response.`);
  return parseJsonLoose(text, providerName);
}

async function anthropicJson(apiKey: string, prompt: string): Promise<unknown> {
  const data = await httpJson(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    "Claude"
  );

  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  const text =
    blocks.find((b) => b?.type === "text")?.text ?? blocks[0]?.text ?? "";
  if (!text) throw new Error("Claude returned an empty response.");
  return parseJsonLoose(text, "Claude");
}

/** Dispatch to the right provider. `geminiSchema` is used only by Gemini. */
async function callProviderJson(
  provider: AiProvider,
  apiKey: string,
  prompt: string,
  geminiSchema?: unknown
): Promise<unknown> {
  if (!IMPLEMENTED_PROVIDERS.has(provider.id)) {
    throw new Error(`${provider.name} isn't supported yet.`);
  }
  if (provider.id === "gemini") return geminiJson(apiKey, prompt, geminiSchema);
  if (provider.id === "claude") return anthropicJson(apiKey, prompt);
  return openAICompatibleJson(provider.id, provider.name, apiKey, prompt);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Scaffold files
// ---------------------------------------------------------------------------

export async function generateFiles(
  provider: AiProvider,
  apiKey: string,
  prompt: string
): Promise<GeneratedFile[]> {
  if (!apiKey.trim()) throw new Error("Paste your API key first.");

  const schema = {
    type: "OBJECT",
    properties: {
      files: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING" },
            contents: { type: "STRING" },
          },
          required: ["path", "contents"],
        },
      },
    },
    required: ["files"],
  };

  const parsed = (await callProviderJson(
    provider,
    apiKey.trim(),
    withFilesContract(prompt),
    schema
  )) as { files?: unknown };

  const files = Array.isArray(parsed.files)
    ? (parsed.files as unknown[]).filter(
        (f): f is GeneratedFile =>
          !!f &&
          typeof (f as GeneratedFile).path === "string" &&
          typeof (f as GeneratedFile).contents === "string"
      )
    : [];

  if (files.length === 0) {
    throw new Error("The model didn't return any files. Try again or tweak the prompt.");
  }
  return files;
}

function withFilesContract(base: string): string {
  return `${base}

Return ONLY a JSON object of the form { "files": [ { "path": "relative/path.ext", "contents": "full file contents" } ] }.
- Paths must be RELATIVE to the project root, use forward slashes, and must NOT contain "..".
- Provide complete, working file contents — no placeholders or ellipses.
- Add or replace a small, focused set of files; do not attempt to rewrite the whole project.`;
}

// ---------------------------------------------------------------------------
// Explain a project
// ---------------------------------------------------------------------------

export interface ProjectExplanation {
  summary: string;
  status: ProjectStatus;
  tags: string[];
}

export async function explainProject(
  provider: AiProvider,
  apiKey: string,
  context: ProjectContext
): Promise<ProjectExplanation> {
  if (!apiKey.trim()) throw new Error("No API key set.");

  const schema = {
    type: "OBJECT",
    properties: {
      summary: { type: "STRING" },
      status: { type: "STRING", enum: PROJECT_STATUSES as unknown as string[] },
      tags: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["summary", "status", "tags"],
  };

  const parsed = (await callProviderJson(
    provider,
    apiKey.trim(),
    buildExplainPrompt(context),
    schema
  )) as Partial<ProjectExplanation>;

  const status = (PROJECT_STATUSES as string[]).includes(parsed.status as string)
    ? (parsed.status as ProjectStatus)
    : "In Development";

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    status,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 4)
      : [],
  };
}

function buildExplainPrompt(c: ProjectContext): string {
  const parts: string[] = [`Project folder name: ${c.name}`];
  if (c.packageJson) parts.push(`package.json:\n${c.packageJson}`);
  if (c.readme) parts.push(`README:\n${c.readme}`);

  return `You are explaining a software project to a NON-TECHNICAL person.

${parts.join("\n\n")}

Produce a JSON object with:
- "summary": ONE or TWO plain-English sentences describing what this project is for and who it helps. Avoid jargon and framework names unless essential.
- "status": your best guess, one of "Live", "In Development", "On Hold".
- "tags": 1–4 short technology or topic tags.

Return ONLY the JSON object.`;
}
