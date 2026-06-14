import type { AiProvider } from "../types";

/**
 * BYOK (bring-your-own-key) AI providers for the "Build by goal" generation
 * step. We never ship our own key — a key baked into a desktop binary would be
 * extracted and abused — so the user supplies their own. Free-tier providers
 * are listed first.
 *
 * NOTE: generation is currently stubbed in the UI, and keys are NOT persisted
 * yet. Real use should store the key in the OS keychain, not localStorage.
 */
/** Keychain entry name for a provider's API key. */
export const secretKeyFor = (providerId: string) => `apikey:${providerId}`;

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    free: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
    note: "Generous free tier — a good default.",
  },
  {
    id: "groq",
    name: "Groq",
    free: true,
    keyUrl: "https://console.groq.com/keys",
    note: "Free and very fast (open models).",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    free: true,
    keyUrl: "https://openrouter.ai/keys",
    note: "One key, many models — some free.",
  },
  {
    id: "claude",
    name: "Claude (Anthropic)",
    free: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "Highest quality for code; paid.",
  },
  {
    id: "openai",
    name: "OpenAI",
    free: false,
    keyUrl: "https://platform.openai.com/api-keys",
    note: "Paid.",
  },
];
