import { HeartbeatResponse, signToken, type RunnerHeartbeat } from "@lemonlime/protocol";
import type { ThreadRunner } from "./thread-runner.ts";

const INTERVAL_MS = 30_000;

export interface HeartbeatOptions {
  controlPlaneUrl: string;
  threadSecret: string;
  version: string;
  /** Called when the control plane asks the runner to shut down. */
  onShutdown(): void;
  log?: (msg: string) => void;
}

/** Tells the control plane how the thread is doing, every 30 s and on every status change. */
export function startHeartbeat(runner: ThreadRunner, opts: HeartbeatOptions): () => void {
  const url = new URL("/api/runner/heartbeat", opts.controlPlaneUrl).toString();
  let inFlight = false;

  const beat = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const t = runner.thread;
      const body: RunnerHeartbeat = { threadId: t.id, status: t.status, latestSeq: t.latestSeq, idleSince: runner.idle, runnerVersion: opts.version };
      const token = await signToken({ threadId: t.id, scope: "runner", exp: Math.floor(Date.now() / 1000) + 300 }, opts.threadSecret);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        opts.log?.(`heartbeat rejected: HTTP ${res.status}`);
        return;
      }
      const parsed = HeartbeatResponse.safeParse(await res.json().catch(() => ({})));
      if (parsed.success && parsed.data.action === "shutdown") opts.onShutdown();
    } catch (err) {
      opts.log?.(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(beat, INTERVAL_MS);
  timer.unref();
  const off = runner.onStatus(() => void beat());
  void beat();
  return () => {
    clearInterval(timer);
    off();
  };
}
