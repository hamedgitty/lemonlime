import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type BackgroundActivity = "build" | "download" | "server";

/** CPU in use across the sandbox between the last two samples, and the busiest program. */
export interface SandboxLoad {
  cpuCores: number;
  topProcess: string | null;
}

/** Programs whose activity is upkeep, not work the user is waiting for. */
const HOUSEKEEPING = new Set([
  "claude",
  "codex",
  "opencode",
  "git",
  "git-remote-http",
  "ssh-agent",
  "tsserver",
  "typingsInstaller",
  "gopls",
  "rust-analyzer",
  "pyright",
  "pylsp",
  "clangd",
  "watchman",
  "sh",
  "bash",
  "sleep",
]);

/** Sustained CPU (in cores) that counts as a build or test run. */
const BUILD_CPU = 0.15;
/** Download speed that counts as fetching something. */
const DOWNLOAD_BYTES_PER_SEC = 100 * 1024;

export interface ActivityMonitorOptions {
  /** Defaults to /proc. Tests point this at a fake tree. */
  procRoot?: string;
  /** Processes and sockets of the runner itself never count. */
  ownPid?: number;
  /** Ports the runner itself listens on. */
  ownPorts?: number[];
  /** Clock ticks per second for /proc CPU times (almost always 100). */
  ticksPerSec?: number;
  now?: () => number;
}

/**
 * Tells whether work is still going on in a sandbox after the agent's turn ended: a build
 * or tests using the CPU, a download, or a dev server listening for connections. Reads
 * Linux's /proc; elsewhere it always says nothing is going on. Call `sample()` regularly;
 * CPU and download rates are measured between calls.
 */
export class ActivityMonitor {
  private readonly proc: string;
  private readonly ownPid: number;
  private readonly ownPorts: Set<number>;
  private readonly ticks: number;
  private readonly now: () => number;
  private last: { at: number; cpu: Map<number, { ticks: number; comm: string }>; rx: number } | null = null;
  private lastLoad: SandboxLoad | null = null;

  constructor(opts: ActivityMonitorOptions = {}) {
    this.proc = opts.procRoot ?? "/proc";
    this.ownPid = opts.ownPid ?? process.pid;
    this.ownPorts = new Set(opts.ownPorts ?? []);
    this.ticks = opts.ticksPerSec ?? 100;
    this.now = opts.now ?? Date.now;
  }

  get supported(): boolean {
    return existsSync(join(this.proc, "net", "tcp"));
  }

  /**
   * CPU use measured by the latest `sample()`, counting every program but the runner
   * (housekeeping included). Null until two samples have been taken.
   */
  load(): SandboxLoad | null {
    return this.lastLoad;
  }

  sample(): BackgroundActivity | null {
    if (!this.supported) return null;
    const at = this.now();
    const cpu = this.cpuByPid();
    const rx = this.receivedBytes();
    const prev = this.last;
    this.last = { at, cpu, rx };

    if (prev && at > prev.at) {
      const seconds = (at - prev.at) / 1000;
      let work = 0;
      let all = 0;
      const byName = new Map<string, number>();
      for (const [pid, t] of cpu) {
        const used = Math.max(0, t.ticks - (prev.cpu.get(pid)?.ticks ?? t.ticks));
        all += used;
        byName.set(t.comm, (byName.get(t.comm) ?? 0) + used);
        if (!HOUSEKEEPING.has(t.comm)) work += used;
      }
      let top: string | null = null;
      for (const [name, used] of byName) if (used > 0 && (top === null || used > byName.get(top)!)) top = name;
      this.lastLoad = { cpuCores: Math.round((all / this.ticks / seconds) * 100) / 100, topProcess: top };
      if (work / this.ticks / seconds >= BUILD_CPU) return "build";
      if ((rx - prev.rx) / seconds >= DOWNLOAD_BYTES_PER_SEC) return "download";
    }
    return this.hasServer() ? "server" : null;
  }

  /** Total CPU ticks per process, with its program name, leaving out the runner itself. */
  private cpuByPid(): Map<number, { ticks: number; comm: string }> {
    const out = new Map<number, { ticks: number; comm: string }>();
    for (const name of safeReaddir(this.proc)) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === this.ownPid) continue;
      const stat = safeRead(join(this.proc, name, "stat"));
      if (!stat) continue;
      // "pid (comm) state ppid ... utime stime": comm may contain spaces, so split after ")".
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const fields = stat.slice(close + 2).split(" ");
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      if (Number.isFinite(utime) && Number.isFinite(stime)) out.set(pid, { ticks: utime + stime, comm });
    }
    return out;
  }

  private receivedBytes(): number {
    const dev = safeRead(join(this.proc, "net", "dev"));
    if (!dev) return 0;
    let total = 0;
    for (const line of dev.split("\n").slice(2)) {
      const [iface, rest] = line.split(":");
      if (!iface || !rest || iface.trim() === "lo") continue;
      total += Number(rest.trim().split(/\s+/)[0]) || 0;
    }
    return total;
  }

  /** A TCP socket listening on a port that isn't the runner's own. */
  private hasServer(): boolean {
    const mine = this.ownSocketInodes();
    for (const file of ["tcp", "tcp6"]) {
      const table = safeRead(join(this.proc, "net", file));
      if (!table) continue;
      for (const line of table.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10 || cols[3] !== "0A") continue; // 0A = LISTEN
        const port = Number.parseInt(cols[1]!.split(":").pop()!, 16);
        if (this.ownPorts.has(port) || mine.has(cols[9]!)) continue;
        return true;
      }
    }
    return false;
  }

  private ownSocketInodes(): Set<string> {
    const out = new Set<string>();
    const fdDir = join(this.proc, String(this.ownPid), "fd");
    for (const fd of safeReaddir(fdDir)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(fdDir, fd)));
        if (m) out.add(m[1]!);
      } catch {
        /* fd closed meanwhile */
      }
    }
    return out;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
