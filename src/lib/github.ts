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
  description: string | null;
  language: string | null;
  /** ISO timestamp of the last push. */
  updatedAt: string | null;
  /** GitHub web URL, for "open on GitHub". */
  htmlUrl: string;
  defaultBranch: string;
  stars: number;
  fork: boolean;
}

function toRepo(r: Record<string, unknown>): GithubRepo {
  return {
    fullName: String(r.full_name),
    name: String(r.name),
    cloneUrl: String(r.clone_url),
    private: !!r.private,
    description: (r.description as string) ?? null,
    language: (r.language as string) ?? null,
    updatedAt: (r.pushed_at as string) ?? (r.updated_at as string) ?? null,
    htmlUrl: String(r.html_url ?? ""),
    defaultBranch: String(r.default_branch ?? "main"),
    stars: Number(r.stargazers_count ?? 0),
    fork: !!r.fork,
  };
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
  if (res.status === 204) return null; // No Content (e.g. DELETE)
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
  return (data as Record<string, unknown>[]).map(toRepo);
}

/**
 * EVERY repo the user can access (owner + collaborator + org member), paginated
 * to completion. Most-recently-pushed first. Used by the GitHub page.
 */
export async function listAllGithubRepos(token: string): Promise<GithubRepo[]> {
  const all: GithubRepo[] = [];
  // Cap at 10 pages (1000 repos) to stay responsive.
  for (let page = 1; page <= 10; page++) {
    const data = (await gh(
      token,
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
    )) as Record<string, unknown>[];
    all.push(...data.map(toRepo));
    if (data.length < 100) break;
  }
  // De-dupe by full name (orgs can surface twice) and keep push order.
  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.fullName) ? false : (seen.add(r.fullName), true)));
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
  return toRepo(r);
}

/** Fetch a single repo's metadata by "owner/repo" slug (e.g. to read visibility). */
export async function getGithubRepo(token: string, slug: string): Promise<GithubRepo> {
  return toRepo(await gh(token, `/repos/${slug}`));
}

/** Flip a repo between private and public. Returns the updated repo. */
export async function setGithubRepoVisibility(
  token: string,
  slug: string,
  isPrivate: boolean
): Promise<GithubRepo> {
  const r = await gh(token, `/repos/${slug}`, {
    method: "PATCH",
    body: JSON.stringify({ private: isPrivate }),
  });
  return toRepo(r);
}

/**
 * Permanently delete a repo on GitHub. The local clone is untouched — callers
 * should also drop the local `origin` remote. Needs a token with the
 * `delete_repo` scope (NOT included in plain `repo`).
 */
export async function deleteGithubRepo(token: string, slug: string): Promise<void> {
  try {
    await gh(token, `/repos/${slug}`, { method: "DELETE" });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/403|denied|not accessible|forbidden/i.test(m)) {
      throw new Error(
        "Deleting a repo needs a classic token with the `delete_repo` scope (it's separate from `repo`). Add it at GitHub → Settings → Developer settings → Tokens (classic), then update your token in Kinetek."
      );
    }
    throw e;
  }
}
