import { useEffect, useState } from "react";
import { inDesktopShell, inspectRepo } from "./native.ts";
import { USAGE_REFRESH_MS, dueForRefresh } from "./agentUsage.ts";

/** inspect_repo's answer for a path that isn't a folder (any more). */
export function isMissingFolderError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /is not a folder/i.test(text);
}

/**
 * Project folders on this computer that are gone (moved or deleted), so the sidebar can
 * say so. Checked when the list changes and when the window comes back to the front (at
 * most every two minutes).
 */
export function useMissingFolders(paths: readonly string[]): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const key = [...new Set(paths)].sort().join("\n");
  useEffect(() => {
    if (!inDesktopShell() || !key) return;
    const list = key.split("\n");
    let live = true;
    let last: number | null = null;
    const check = () => {
      const now = Date.now();
      if (!dueForRefresh(last, now, USAGE_REFRESH_MS)) return;
      last = now;
      void Promise.all(
        list.map(p =>
          inspectRepo(p).then(
            () => null,
            err => (isMissingFolderError(err) ? p : null),
          ),
        ),
      ).then(found => {
        if (!live) return;
        const next = new Set(found.filter((p): p is string => p !== null));
        setMissing(cur => (cur.size === next.size && [...next].every(p => cur.has(p)) ? cur : next));
      });
    };
    check();
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
  }, [key]);
  return missing;
}
