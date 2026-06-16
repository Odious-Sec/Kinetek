import { useEffect, useState } from "react";
import type { GitStatus, Project } from "../types";
import { gitStatus, isTauri } from "../lib/tauri";

export type StatusMap = Record<string, GitStatus | null>;

/**
 * Fetch git status for every real (non-sample) project, keyed by project id.
 * Used by the dashboard widgets to summarize work at a glance. Re-runs when the
 * set of project paths changes. No-op (empty map) outside the desktop app.
 */
export function useProjectStatuses(projects: Project[]): {
  statuses: StatusMap;
  loading: boolean;
} {
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [loading, setLoading] = useState(false);

  // Stable dependency: the list of real project paths.
  const real = projects.filter((p) => !p.id.startsWith("sample-"));
  const key = real.map((p) => p.path).join("|");

  useEffect(() => {
    if (!isTauri() || real.length === 0) {
      setStatuses({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      real.map(
        async (p) => [p.id, await gitStatus(p.path).catch(() => null)] as const
      )
    )
      .then((entries) => {
        if (!cancelled) setStatuses(Object.fromEntries(entries));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { statuses, loading };
}
