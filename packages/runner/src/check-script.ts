import { spawn } from "node:child_process";
import { CHECK_OUTPUT_MAX_CHARS, CHECK_TIMEOUT_MS, checkVerdict, type CheckVerdict } from "@lemonlime/protocol";
import { shellEnv } from "./terminal.ts";

/** Most of a check script's output kept while it runs (the agent gets less than this). */
const KEEP_BYTES = CHECK_OUTPUT_MAX_CHARS * 4;

/**
 * Run an automation's check script in the thread's folder and say whether the run should
 * go ahead. Only what it prints to stdout counts; it gets the shell's environment without
 * the runner's own secrets, and is stopped (with everything it started) after the timeout.
 */
export function runCheckScript(script: string, cwd: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CheckVerdict> {
  return new Promise(resolve => {
    let output = "";
    let kept = 0;
    let timedOut = false;
    let settled = false;
    const done = (r: Parameters<typeof checkVerdict>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(checkVerdict(r));
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", script], {
        cwd,
        env: { ...shellEnv(opts.env), TERM: "dumb", COLORTERM: "" } satisfies Record<string, string> as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "ignore"],
        // Its own process group, so a timeout stops whatever it started too.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return done({ exitCode: null, output: "", error: err instanceof Error ? err.message : String(err) });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (kept >= KEEP_BYTES) return;
      output += chunk.slice(0, KEEP_BYTES - kept);
      kept += chunk.length;
    });
    child.on("error", err => done({ exitCode: null, output: "", error: err.message }));
    child.on("close", code => done({ exitCode: code, output, timedOut }));
  });
}
