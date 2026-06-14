import { fetch } from "@tauri-apps/plugin-http";

/**
 * Minimal GitHub REST client (via Tauri's HTTP plugin, so no CORS). The token
 * is the user's PAT from the keychain. Used to connect a project to a repo
 * without touching the Terminal.
 */

const API = "https://api.github.com";

export interface GithubRepo {
  fullName: string;
  name: string;
  cloneUrl: string;
  private: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function gh(token: string, path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers as Record<string, string>),
      },
    });
  } catch (e) {
    throw new Error(
      `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!res.ok) {
    let msg = "";
    try {
      const j = await res.json();
      msg = j?.message ?? "";
      if (Array.isArray(j?.errors) && j.errors[0]?.message) {
        msg += ` (${j.errors[0].message})`;
      }
    } catch {
      /* non-JSON */
    }
    if (res.status === 401) {
      throw new Error("GitHub rejected the token. Use a classic token with the `repo` scope.");
    }
    if (res.status === 403) {
      if (/personal access token|not accessible/i.test(msg)) {
        throw new Error(
          "Your token can't do this — it's likely a fine-grained token. Create a CLASSIC token with the `repo` scope (GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)), then paste it in the Change field."
        );
      }
      throw new Error(`GitHub denied the request${msg ? `: ${msg}` : " (scope or rate limit)"}.`);
    }
    throw new Error(`GitHub request failed (HTTP ${res.status})${msg ? `: ${msg}` : ""}`);
  }
  return res.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Validate the token and return the authenticated user's login. */
export async function getGithubUser(token: string): Promise<{ login: string }> {
  const u = await gh(token, "/user");
  return { login: u.login };
}

/** The user's own repositories (most-recently-updated first). */
export async function listGithubRepos(token: string): Promise<GithubRepo[]> {
  const data = await gh(
    token,
    "/user/repos?per_page=100&sort=updated&affiliation=owner"
  );
  return (data as Record<string, unknown>[]).map((r) => ({
    fullName: String(r.full_name),
    name: String(r.name),
    cloneUrl: String(r.clone_url),
    private: !!r.private,
  }));
}

/** Create a new repo under the authenticated account (empty, no auto-init). */
export async function createGithubRepo(
  token: string,
  name: string,
  isPrivate: boolean
): Promise<GithubRepo> {
  const r = await gh(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });
  return {
    fullName: String(r.full_name),
    name: String(r.name),
    cloneUrl: String(r.clone_url),
    private: !!r.private,
  };
}
