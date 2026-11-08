import { spawn, type ChildProcess } from "node:child_process";
import { lineSplitter } from "./lines.ts";
import { AgentError, classifyAgentFailure } from "./types.ts";

export interface LineProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  /**
   * Written to the CLI's stdin, which is then closed. Prompts go this way rather than on the
   * command line, where one starting with "-" reads as a flag and long ones hit the OS limit.
   */
  input?: string;
  onLine(line: string): void;
  /** A line too long to keep was dropped. */
  onOversize?(bytes: number): void;
}

/** Last bytes of stderr, for error messages. */
const STDERR_TAIL = 4000;

/**
 * Run a CLI that prints one JSON object per line. Resolves when it exits 0,
 * rejects with an AgentError otherwise. Aborting sends SIGINT, then SIGKILL.
 */
export function runLineProcess(o: LineProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: { ...process.env, ...o.env },
        stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group, so stopping it also stops what it started (see killGently).
        detached: GROUPS,
      });
      track(child);
    } catch (err) {
      reject(new AgentError(`Could not start ${o.command}: ${String(err)}`, "agent_not_found"));
      return;
    }

    if (o.input !== undefined && child.stdin) {
      // A CLI that exits without reading all of it closes the pipe; that's not our failure.
      child.stdin.on("error", () => undefined);
      child.stdin.end(o.input);
    }

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-STDERR_TAIL);
    });
    const lines = lineSplitter(o.onLine, bytes => o.onOversize?.(bytes));
    child.stdout!.on("data", (d: Buffer) => lines.write(d));
    child.stdout!.on("end", () => lines.end());

    const stop = () => killGently(child);
    if (o.signal.aborted) stop();
    o.signal.addEventListener("abort", stop, { once: true });

    child.on("error", err => {
      o.signal.removeEventListener("abort", stop);
      const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
      reject(new AgentError(notFound ? `${o.command} is not installed or not on PATH` : err.message, notFound ? "agent_not_found" : "agent_failed"));
    });
    child.on("close", (code, signal) => {
      o.signal.removeEventListener("abort", stop);
      if (o.signal.aborted) return resolve();
      if (code === 0) return resolve();
      if (code === null && signal) {
        // Killed from outside (out of memory, the OS, a crash): not something the agent decided.
        reject(new AgentError(`${o.command} stopped unexpectedly (${signal})${stderr.trim() ? `: ${stderr.trim()}` : ""}`, "agent_crashed"));
        return;
      }
      reject(new AgentError(`${o.command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`, classifyAgentFailure(stderr)));
    });
  });
}

/** Agents run in their own process group, except on Windows, which has none. */
export const GROUPS = process.platform !== "win32";

/** Process groups of agents started by this runner that may still have members. */
const groups = new Set<number>();

/**
 * Remember a spawned agent's process group, so a stop or shutdown reaches the shells, builds
 * and servers it started too, even after the agent itself has exited.
 */
export function track(child: ChildProcess): void {
  if (!GROUPS || !child.pid) return;
  groups.add(child.pid);
  // Its own exit doesn't end the group: background jobs it started live on until a stop.
  // Forget it only once nothing is left in the group.
  child.once("close", () => {
    if (!groupAlive(child.pid!)) groups.delete(child.pid!);
  });
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (GROUPS && child.pid) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // The group is gone, or it never was one: fall back to the process itself.
    }
  }
  try {
    child.kill(sig);
  } catch {
    // Already gone.
  }
}

/** Stop an agent and everything it started: SIGINT to its group, SIGKILL after the grace period. */
export function killGently(child: ChildProcess, graceMs = 3000): void {
  const leaderRunning = child.exitCode === null && child.signalCode === null;
  if (!leaderRunning && !(GROUPS && child.pid && groupAlive(child.pid))) return;
  signalGroup(child, "SIGINT");
  const t = setTimeout(() => {
    signalGroup(child, "SIGKILL");
    if (child.pid) groups.delete(child.pid);
  }, graceMs);
  t.unref();
}

/** On the runner's way out: end every agent process group it started. */
export function killAllAgentGroups(): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  groups.clear();
}

export function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
