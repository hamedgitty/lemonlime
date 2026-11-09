import { execFile } from "node:child_process";

/**
 * Finding dev servers on their own: while the thread is busy, look at the processes the
 * runner started (the agent, its tools, the terminals; all carry LEMONLIME_THREAD_ID) and
 * the TCP ports they listen on, so the app can offer "Open localhost:5173" without the agent
 * having to say. Only this runner's own process tree is looked at, only every few seconds,
 * and only while something is happening. Uses `ps` and `lsof` (macOS and Linux); Windows is
 * skipped.
 */

export interface ListeningPort {
  port: number;
  /** The program listening, e.g. "node" (as lsof names it). */
  command: string;
}

/** `ps -A -o pid=,ppid=` → every process below `root` (not `root` itself). */
export function descendants(psOutput: string, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out.sort((a, b) => a - b);
}

/** `lsof -F pcn` for listening TCP sockets → each port once, with the program on it. */
export function parseLsofListen(output: string): ListeningPort[] {
  const ports = new Map<number, string>();
  let command = "";
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") command = "";
    else if (tag === "c") command = value;
    else if (tag === "n") {
      // "*:5173", "127.0.0.1:3000", "[::1]:8080"; a connection would have "->", skip those.
      if (value.includes("->")) continue;
      const m = /:(\d+)$/.exec(value);
      const port = m ? Number(m[1]) : NaN;
      if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.has(port)) ports.set(port, command || "a program");
    }
  }
  return [...ports.entries()].map(([port, cmd]) => ({ port, command: cmd.slice(0, 80) })).sort((a, b) => a.port - b.port);
}

type Run = (file: string, args: string[]) => Promise<string>;

const run: Run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits 1 when nothing matched: that's just no ports.
      if (err && !(file === "lsof" && (err as { code?: unknown }).code === 1)) reject(err);
      else resolve(stdout);
    }),
  );

/** The ports the processes below `root` listen on now (empty when there are none, or no lsof). */
export async function listeningPortsBelow(root: number, exec: Run = run): Promise<ListeningPort[]> {
  const pids = descendants(await exec("ps", ["-A", "-o", "pid=,ppid="]), root);
  if (!pids.length) return [];
  return parseLsofListen(await exec("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.slice(0, 500).join(","), "-F", "pcn"]));
}

export interface PortWatcherOptions {
  /** The runner's own process. */
  root?: number;
  /** Ports never offered (the runner's own). */
  ignore: () => readonly number[];
  /** The listening ports changed. */
  onChange: (ports: ListeningPort[]) => void;
  intervalMs?: number;
  /** Keep looking this long after the last sign of activity. */
  graceMs?: number;
  platform?: NodeJS.Platform;
  exec?: Run;
}

/**
 * Looks for new listening ports while the thread is active: `busy(true)` while the agent
 * works, `touch()` when a terminal is used. It keeps looking for a while after either.
 */
export class PortWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busyNow = false;
  private activeUntil = 0;
  private last = "";
  private broken = false;
  private stopped = false;
  private polling = false;

  constructor(private readonly o: PortWatcherOptions) {
    if ((o.platform ?? process.platform) === "win32") this.broken = true;
  }

  /** The agent started or stopped working. */
  busy(on: boolean): void {
    this.busyNow = on;
    if (!on) this.activeUntil = Date.now() + (this.o.graceMs ?? 30_000);
    this.schedule(0);
  }

  /** Something happened in a terminal (a script started, the user typed). */
  touch(): void {
    this.activeUntil = Math.max(this.activeUntil, Date.now() + (this.o.graceMs ?? 30_000) * 4);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private get active(): boolean {
    return this.busyNow || Date.now() < this.activeUntil;
  }

  private schedule(ms: number): void {
    if (this.broken || this.stopped || this.timer || this.polling) return;
    this.timer = setTimeout(() => void this.poll(), ms);
    this.timer.unref?.();
  }

  /** Look once now (exposed for tests). */
  async poll(): Promise<void> {
    this.timer = null;
    if (this.broken || this.stopped || !this.active) return;
    this.polling = true;
    try {
      const ignore = new Set(this.o.ignore());
      const ports = (await listeningPortsBelow(this.o.root ?? process.pid, this.o.exec)).filter(p => !ignore.has(p.port));
      const key = ports.map(p => `${p.port}:${p.command}`).join(",");
      if (key !== this.last) {
        this.last = key;
        this.o.onChange(ports);
      }
    } catch (err) {
      // No ps or lsof here: stop trying.
      if ((err as { code?: unknown }).code === "ENOENT") this.broken = true;
    } finally {
      this.polling = false;
    }
    if (this.active) this.schedule(this.o.intervalMs ?? 3000);
  }
}
