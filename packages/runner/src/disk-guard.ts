import { readFile, statfs } from "node:fs/promises";
import { descendants, listProcesses, type Proc } from "./memory-guard.ts";

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export async function diskSpace(path: string): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

export interface DiskGuardOptions {
  path: string;
  intervalMs?: number;
  /** Warn below this share of the disk free (default 15%). */
  warnBelow?: number;
  /** Pause the agent below this (default 5%) and resume at `resumeAt` (default 8%). */
  pauseBelow?: number;
  resumeAt?: number;
  read?: (path: string) => Promise<DiskSpace | null>;
  onWarn(space: DiskSpace): void;
  onPause(space: DiskSpace): void;
  onResume(space: DiskSpace): void;
  /** Still under the pause line this long after pausing (default 30 s): something else is filling it. */
  onStillFull?(space: DiskSpace): void;
  stillFullAfterMs?: number;
  now?: () => number;
}

/**
 * Watches free disk space where the thread works. A full disk breaks builds, git and the
 * runner's own history, so: a warning at 15% free, the agent paused under 5% (new messages
 * wait) and picked up again at 8%. The gap stops it flapping around one line.
 */
export class DiskGuard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;
  private pausedAt: number | null = null;
  private toldStillFull = false;

  constructor(private readonly opts: DiskGuardOptions) {}

  start(): this {
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? 30_000);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  async check(): Promise<void> {
    const space = await (this.opts.read ?? diskSpace)(this.opts.path);
    if (!space || space.totalBytes <= 0) return;
    const free = space.freeBytes / space.totalBytes;
    const now = (this.opts.now ?? Date.now)();
    const warn = this.opts.warnBelow ?? 0.15;
    const pause = this.opts.pauseBelow ?? 0.05;
    const resume = this.opts.resumeAt ?? 0.08;

    if (this.pausedAt !== null) {
      if (free >= resume) {
        this.pausedAt = null;
        this.toldStillFull = false;
        this.opts.onResume(space);
      } else if (!this.toldStillFull && now - this.pausedAt >= (this.opts.stillFullAfterMs ?? 30_000) && free < pause) {
        this.toldStillFull = true;
        this.opts.onStillFull?.(space);
      }
      return;
    }
    if (free < pause) {
      this.pausedAt = now;
      this.warned = true;
      this.opts.onPause(space);
      return;
    }
    if (free < warn && !this.warned) {
      this.warned = true;
      this.opts.onWarn(space);
    } else if (free >= warn + 0.05) this.warned = false;
  }
}

/**
 * Of the programs the runner started, the one that has written the most (Linux, from
 * /proc/<pid>/io). Null elsewhere, or when nothing has written.
 */
export async function biggestWriter(rootPid = process.pid): Promise<(Proc & { writtenBytes: number }) | null> {
  if (process.platform !== "linux") return null;
  const procs = await listProcesses();
  if (!procs) return null;
  let best: (Proc & { writtenBytes: number }) | null = null;
  for (const p of descendants(procs, rootPid)) {
    const io = await readFile(`/proc/${p.pid}/io`, "utf8").catch(() => "");
    const written = Number(/write_bytes:\s*(\d+)/.exec(io)?.[1] ?? 0);
    if (written > 0 && (!best || written > best.writtenBytes)) best = { ...p, writtenBytes: written };
  }
  return best;
}

export const formatBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
