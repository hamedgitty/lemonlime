import { spawn as spawnChild } from "node:child_process";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { MAX_TERMINALS, TERMINAL_REPLAY_CHARS } from "@lemonlime/protocol";

/** The slice of node-pty we use. */
export interface Pty {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type SpawnPty = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string>; name: string }) => Pty;

/**
 * node-pty, prebuilt for each platform. The desktop app's single-file runner can't carry a
 * native module inside it, so the app ships it alongside and says where
 * (LEMONLIME_NODE_PTY_DIR, a folder holding node_modules/@lydell/node-pty).
 */
export async function loadPty(env: NodeJS.ProcessEnv = process.env): Promise<SpawnPty | null> {
  try {
    if (env.LEMONLIME_NODE_PTY_DIR) {
      const req = createRequire(join(env.LEMONLIME_NODE_PTY_DIR, "index.js"));
      return (req("@lydell/node-pty") as { spawn: SpawnPty }).spawn;
    }
    const mod = (await import("@lydell/node-pty")) as unknown as { spawn?: SpawnPty; default?: { spawn: SpawnPty } };
    return mod.spawn ?? mod.default?.spawn ?? null;
  } catch {
    return null;
  }
}

/** Environment for the shell: the runner's own, without anything that would let it act as the runner. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "LEMONLIME_THREAD_SECRET" || k === "LEMONLIME_AGENT_KEY" || k === "LEMONLIME_APPROVAL_TOKEN" || k === "LEMONLIME_AGENT_FILES") continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}

const defaultShell = () => process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");

/** A login shell, or one that runs `command` and ends (PowerShell and cmd on Windows). */
export function shellArgs(shell: string, command: string | null, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    if (!command) return [];
    return /cmd(\.exe)?$/i.test(shell) ? ["/d", "/s", "/c", command] : ["-NoLogo", "-Command", command];
  }
  return command ? ["-l", "-c", command] : ["-l"];
}

export interface ScriptRun {
  ok: boolean;
  /** The exit code, or null when it was stopped (timed out, or the runner is closing). */
  code: number | null;
  timedOut: boolean;
  /** The end of what it printed. */
  output: string;
  ms: number;
}

/** Most of a script's output kept for its notice. */
const SCRIPT_OUTPUT_KEPT = 6000;

/**
 * Run a command to the end in a login shell, without a terminal (setup when a worktree is
 * made). It gets its own process group, so a timeout stops everything it started.
 */
export function runScriptToEnd(o: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  shell?: string;
  signal?: AbortSignal;
}): Promise<ScriptRun> {
  const started = Date.now();
  const shell = o.shell ?? defaultShell();
  return new Promise(resolve => {
    let output = "";
    let timedOut = false;
    const keep = (b: Buffer) => {
      output = (output + b.toString()).slice(-SCRIPT_OUTPUT_KEPT * 2);
    };
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(shell, shellArgs(shell, o.command), {
        cwd: o.cwd,
        env: { ...shellEnv(), ...o.env, TERM: "dumb" } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return resolve({ ok: false, code: null, timedOut: false, output: err instanceof Error ? err.message : String(err), ms: 0 });
    }
    const stop = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    o.signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", err => keep(Buffer.from(`\n${err.message}\n`)));
    child.on("close", code => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      const text = output.trim();
      resolve({
        ok: code === 0 && !timedOut,
        code: timedOut ? null : code,
        timedOut,
        output: text.length > SCRIPT_OUTPUT_KEPT ? `…${text.slice(-SCRIPT_OUTPUT_KEPT)}` : text,
        ms: Date.now() - started,
      });
    });
  });
}

export type TerminalListener = {
  output(data: string, end: number): void;
  exit(code: number | null): void;
  restarted(shell: number): void;
  /** The terminal was closed for good (its tab closed in some app). */
  closed?(): void;
};

/**
 * The thread's one shell. Starts on first use, keeps the last `TERMINAL_REPLAY_CHARS` of
 * output for clients that reconnect, and keeps running when nobody is connected.
 */
export class TerminalSession {
  private pty: Pty | null = null;
  /** A script this terminal runs instead of an interactive shell (see project-scripts). */
  command: string | null;
  private chunks: string[] = [];
  private kept = 0;
  /** Characters of output since the shell started. */
  private total = 0;
  private listeners = new Set<TerminalListener>();
  private size = { cols: 100, rows: 30 };
  /** Bumped for every new shell, so clients know their offsets belong to an old one. */
  generation = 0;

  constructor(
    private readonly spawn: SpawnPty,
    private readonly cwd: string,
    private readonly shell: string = defaultShell(),
    private readonly env: Record<string, string> = {},
    command: string | null = null,
  ) {
    this.command = command;
  }

  /** The shell program's name, e.g. "zsh". */
  get name(): string {
    return basename(this.shell).replace(/\.exe$/i, "");
  }

  get running(): boolean {
    return this.pty !== null;
  }

  get end(): number {
    return this.total;
  }

  /** Start the shell if it isn't running. */
  start(): void {
    if (this.pty) return;
    this.chunks = [];
    this.kept = 0;
    this.total = 0;
    this.generation++;
    for (const l of this.listeners) l.restarted(this.generation);
    const pty = this.spawn(this.shell, shellArgs(this.shell, this.command), {
      ...this.size,
      cwd: this.cwd,
      env: { ...shellEnv(), ...this.env },
      name: "xterm-256color",
    });
    this.pty = pty;
    pty.onData(data => {
      this.total += data.length;
      this.chunks.push(data);
      this.kept += data.length;
      while (this.kept > TERMINAL_REPLAY_CHARS && this.chunks.length > 1) this.kept -= this.chunks.shift()!.length;
      for (const l of this.listeners) l.output(data, this.total);
    });
    pty.onExit(({ exitCode }) => {
      if (this.pty === pty) this.pty = null;
      for (const l of this.listeners) l.exit(exitCode);
    });
  }

  /**
   * What a client resuming from `from` missed. `reset` when that's no longer known (too old,
   * from an earlier shell, or ahead of us): then everything kept is sent.
   */
  replay(from: number | undefined, shell?: number): { reset: boolean; data: string } {
    const start = this.total - this.kept;
    const all = this.chunks.join("");
    if (from === undefined || shell !== this.generation || from < start || from > this.total) return { reset: true, data: all };
    return { reset: false, data: all.slice(from - start) };
  }

  subscribe(l: TerminalListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    try {
      this.pty?.resize(cols, rows);
    } catch {
      /* the shell is exiting */
    }
  }

  close(): void {
    this.pty?.kill();
    this.pty = null;
    for (const l of this.listeners) l.closed?.();
    this.listeners.clear();
  }
}

/**
 * A thread's terminals, by the id the app gave each. At most `max` at once, so a buggy or
 * hostile client can't start shells without end.
 */
export class TerminalPool {
  private sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly spawn: SpawnPty,
    private readonly cwd: string,
    readonly max: number = MAX_TERMINALS,
    private readonly shell?: string,
    /** Extra variables for every terminal (the thread's id and paths). */
    private readonly env: Record<string, string> = {},
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** The terminal with this id, made (not started) if it's new and there's room. A `command` makes it run that script. */
  open(id: string, opts: { command?: string; env?: Record<string, string> } = {}): TerminalSession | null {
    const known = this.sessions.get(id);
    if (known) return known;
    if (this.sessions.size >= this.max) return null;
    const session = new TerminalSession(this.spawn, this.cwd, this.shell, { ...this.env, ...opts.env }, opts.command ?? null);
    this.sessions.set(id, session);
    return session;
  }

  /** End a terminal's shell and forget it. */
  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.close();
  }

  closeAll(): void {
    for (const id of this.ids()) this.close(id);
  }
}
