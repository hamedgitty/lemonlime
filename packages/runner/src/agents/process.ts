import { spawn, type ChildProcess } from "node:child_process";
import { lineSplitter } from "./lines.ts";
import { AgentError, classifyAgentFailure } from "./types.ts";

export interface LineProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
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
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(new AgentError(`Could not start ${o.command}: ${String(err)}`, "agent_not_found"));
      return;
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

export function killGently(child: ChildProcess, graceMs = 3000): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGINT");
  const t = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, graceMs);
  t.unref();
}

export function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
