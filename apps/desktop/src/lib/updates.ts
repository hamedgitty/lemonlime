import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AvailableUpdate {
  version: string;
  /** The release notes (Markdown), or "" when the release has none. */
  notes: string;
  /**
   * Download and install it (once), then restart into the new version. The restart asks
   * first while an agent on this computer is mid-turn, the same as quitting, unless
   * `confirmed` says the person already agreed.
   */
  install(o?: { onProgress?: (fraction: number) => void; confirmed?: boolean }): Promise<void>;
}

/** What restarting does to an agent that's mid-turn, for the confirmation. */
export const RESTART_WHILE_WORKING =
  "An agent on this computer is still working. Restart to update anyway? It stops now, and what it changed so far stays on its branch.";

/**
 * Ask GitHub releases whether a newer, signed version exists. Null when up to date, when
 * not running in the desktop app, or when the check can't be made (offline): updates are
 * never a reason to show an error.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check().catch(() => null);
  if (!update) return null;
  let installed = false;
  return {
    version: update.version,
    notes: update.body?.trim() ?? "",
    async install(o = {}) {
      if (!installed) {
        let total = 0;
        let done = 0;
        await update.downloadAndInstall(e => {
          if (e.event === "Started") total = e.data.contentLength ?? 0;
          if (e.event === "Progress") {
            done += e.data.chunkLength;
            if (total) o.onProgress?.(Math.min(1, done / total));
          }
        });
        installed = true;
      }
      // The native side restarts at once when nothing is running, and otherwise asks the
      // window first (see confirm-quit in App.tsx); a "no" leaves the update for next launch.
      if (o.confirmed) await invoke("confirm_quit", { restart: true });
      else await invoke("request_restart");
    },
  };
}
