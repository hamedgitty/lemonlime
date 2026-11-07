import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";

export interface Proc {
  pid: number;
  ppid: number;
  /** Resident memory in bytes. */
  rss: number;
  name: string;
}

/** Every process on the machine, from `ps` (macOS and Linux). Null where there's no `ps`. */
export function listProcesses(): Promise<Proc[] | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise(resolve => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const out: Proc[] = [];
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, name: m[4]!.trim().split("/").pop() ?? "" });
      }
      resolve(out);
    });
  });
}

/** `root`'s descendants (not `root` itself). */
export function descendants(procs: Proc[], root: number): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    if (p.pid === root || out.some(o => o.pid === p.pid)) continue;
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

export interface MemoryGuardOptions {
  /** Defaults to half this computer's memory. */
  limitBytes?: number;
  intervalMs?: number;
  rootPid?: number;
  list?: () => Promise<Proc[] | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Over the limit: stop the agent's turn and tell the user. Called once per episode. */
  onOver(info: { usedBytes: number; limitBytes: number; biggest: Proc | null }): void;
  /** Still over after the turn was stopped: the biggest program was killed. */
  onKilled?(proc: Proc): void;
}

const GB = 1024 ** 3;
export const formatGb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

/**
 * Keeps a local thread from taking the computer down: when the programs the agent started
 * use more than half the machine's memory, the turn is stopped and the user told why. If
 * they're still over at the next check (a dev server or build left behind), the biggest
 * one is stopped too.
 */
export class MemoryGuard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private over = false;
  readonly limitBytes: number;

  constructor(private readonly opts: MemoryGuardOptions) {
    this.limitBytes = opts.limitBytes ?? Math.floor(totalmem() / 2);
  }

  start(): this {
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? 15_000);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    const procs = await (this.opts.list ?? listProcesses)();
    if (!procs) return;
    const tree = descendants(procs, this.opts.rootPid ?? process.pid);
    const used = tree.reduce((n, p) => n + p.rss, 0);
    if (used <= this.limitBytes) {
      this.over = false;
      return;
    }
    const biggest = tree.reduce<Proc | null>((a, p) => (!a || p.rss > a.rss ? p : a), null);
    if (!this.over) {
      this.over = true;
      this.opts.onOver({ usedBytes: used, limitBytes: this.limitBytes, biggest });
      return;
    }
    if (biggest) {
      const kill = this.opts.kill ?? ((pid, sig) => process.kill(pid, sig));
      try {
        kill(biggest.pid, "SIGTERM");
        this.opts.onKilled?.(biggest);
        const t = setTimeout(() => {
          try {
            kill(biggest.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000);
        t.unref?.();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Out-of-memory score given to what the agent starts, so Linux kills a build before the agent. */
export const OOM_SCORE_FOR_WORK = 500;

/**
 * When a sandbox runs out of memory, Linux kills the process with the highest score. The
 * runner and the agent CLI it started keep theirs; everything further down (builds, test
 * runs, dev servers, the terminal's commands) gets raised, which needs no privileges. So a
 * runaway build is what dies, and the agent lives to say what happened. Linux only.
 */
export async function prioritizeMemory(rootPid = process.pid, list: () => Promise<Proc[] | null> = listProcesses, procRoot = "/proc"): Promise<number> {
  if (process.platform !== "linux" && procRoot === "/proc") return 0;
  const procs = await list();
  if (!procs) return 0;
  const direct = new Set(procs.filter(p => p.ppid === rootPid).map(p => p.pid));
  let changed = 0;
  for (const p of descendants(procs, rootPid)) {
    if (direct.has(p.pid)) continue;
    const file = `${procRoot}/${p.pid}/oom_score_adj`;
    const now = Number((await readFile(file, "utf8").catch(() => "")).trim());
    if (Number.isFinite(now) && now >= OOM_SCORE_FOR_WORK) continue;
    if (
      await writeFile(file, String(OOM_SCORE_FOR_WORK)).then(
        () => true,
        () => false,
      )
    )
      changed++;
  }
  return changed;
}
