import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One runner per thread: two writing the same history would interleave their events, and
 * the history would be cut short at the first one out of order. Takes `runner.lock` in the
 * thread's data folder (holding this process's id), clearing a lock left by a runner that
 * is no longer alive. Throws when another live runner holds it. Returns the release.
 */
export function takeRunnerLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "runner.lock");
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (readFileSync(file, "utf8").trim() === mine) unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder = 0;
      try {
        holder = Number(readFileSync(file, "utf8").trim());
      } catch {
        continue; // Removed in between: try again.
      }
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder))
        throw new Error(`Another runner (process ${holder}) is already running this thread.`);
      try {
        unlinkSync(file); // Left behind by a runner that stopped without cleaning up.
      } catch {
        // Someone else cleared it first.
      }
    }
  }
  throw new Error("Couldn't take this thread's runner lock.");
}
