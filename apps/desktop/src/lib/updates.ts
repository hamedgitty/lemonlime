import { isTauri } from "@tauri-apps/api/core";

export interface AvailableUpdate {
  version: string;
  notes: string;
  /** Download, install and restart into the new version. */
  install(onProgress?: (fraction: number) => void): Promise<void>;
}

/**
 * Ask GitHub releases whether a newer, signed version exists. Null when up to date, when
 * not running in the desktop app, or when the check can't be made (offline): updates are
 * never a reason to show an error.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null;
  const [{ check }, { relaunch }] = await Promise.all([import("@tauri-apps/plugin-updater"), import("@tauri-apps/plugin-process")]);
  const update = await check().catch(() => null);
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body ?? "",
    async install(onProgress) {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall(e => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          if (total) onProgress?.(Math.min(1, done / total));
        }
      });
      await relaunch();
    },
  };
}
