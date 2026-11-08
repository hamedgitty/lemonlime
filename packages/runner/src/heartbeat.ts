import { HeartbeatResponse, RunnerHistoryResponse, RunnerInbox, signToken, type RunnerHeartbeat, type ThreadEvent } from "@lemonlime/protocol";
import { ActivityMonitor } from "./activity.ts";
import type { ThreadRunner } from "./thread-runner.ts";
import { relayResponse, type Relay } from "./relay.ts";

const INTERVAL_MS = 30_000;
/** Most events, and roughly most bytes, sent in one history upload. */
const HISTORY_BATCH_EVENTS = 1000;
const HISTORY_BATCH_BYTES = 2 * 1024 * 1024;
/** After the control plane says it keeps no history, ask again this much later. */
const HISTORY_RETRY_MS = 10 * 60_000;

export interface HeartbeatOptions {
  controlPlaneUrl: string;
  /** The thread's secret, or (from a keeper) a way to sign runner tokens without it. */
  threadSecret?: string;
  signRunner?: (seconds: number) => Promise<string>;
  version: string;
  /** Called when the control plane asks the runner to shut down. */
  onShutdown(): void;
  log?: (msg: string) => void;
  /** Ports the runner listens on, so they don't count as a dev server. */
  ownPorts?: number[];
  /** For tests. */
  intervalMs?: number;
  activity?: Pick<ActivityMonitor, "sample" | "load">;
  /** Relay mode: calls wait for the control plane to collect them instead of being sent. */
  relay?: Relay;
}

export interface Heartbeat {
  stop(): void;
  /** Send a heartbeat now (also syncs history and picks up waiting messages). */
  beat(): Promise<void>;
}

/**
 * Keeps the control plane up to date, every 30 s and on every status change: status and
 * background work in the heartbeat, history uploaded alongside so it survives the sandbox,
 * and messages sent while the sandbox was paused picked up into the queue. When the
 * control plane says `drain` (a pause is coming), everything is uploaded first and the
 * next heartbeat says `drained: true`.
 */
export function startHeartbeat(runner: ThreadRunner, opts: HeartbeatOptions): Heartbeat {
  const base = opts.controlPlaneUrl.replace(/\/+$/, "");
  const activity = opts.activity ?? new ActivityMonitor({ ownPorts: opts.ownPorts ?? [] });
  const threadId = runner.thread.id;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let storedSeq = 0;
  let historyOffUntil = 0;
  let drained = false;

  const token = () =>
    opts.signRunner ? opts.signRunner(300) : signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + 300 }, opts.threadSecret ?? "");
  const call = async (path: string, init: { method: string; body?: unknown }) => {
    if (opts.relay)
      return relayResponse(
        await opts.relay.request({
          method: init.method === "GET" ? "GET" : "POST",
          path,
          authorization: `Bearer ${await token()}`,
          ...(init.body !== undefined ? { body: init.body } : {}),
        }),
      );
    const res = await fetch(`${base}${path}`, {
      method: init.method,
      headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return res;
  };

  /** Upload history the control plane doesn't have yet. Returns false if it can't keep history. */
  const syncHistory = async (all: boolean): Promise<boolean> => {
    if (Date.now() < historyOffUntil) return false;
    for (let rounds = 0; rounds < (all ? 1000 : 5); rounds++) {
      const pending = runner.store.since(storedSeq);
      if (pending.length === 0) return true;
      const batch: ThreadEvent[] = [];
      let bytes = 0;
      for (const e of pending) {
        const size = JSON.stringify(e).length;
        if (batch.length > 0 && (batch.length >= HISTORY_BATCH_EVENTS || bytes + size > HISTORY_BATCH_BYTES)) break;
        batch.push(e);
        bytes += size;
      }
      const res = await call("/api/runner/history", { method: "POST", body: { threadId, events: batch } });
      if (res.status === 404 || res.status === 501) {
        historyOffUntil = Date.now() + HISTORY_RETRY_MS;
        return false;
      }
      if (!res.ok) throw new Error(`history upload rejected: HTTP ${res.status}`);
      const parsed = RunnerHistoryResponse.safeParse(await res.json().catch(() => ({})));
      if (!parsed.success) throw new Error("history upload: unexpected response");
      // The control plane says how far it has got, which may be further than we sent
      // (after a resume it already holds the earlier history).
      const before = storedSeq;
      storedSeq = parsed.data.storedSeq;
      if (storedSeq === before) return true; // nothing accepted; try again next beat
    }
    return true;
  };

  /** Bring messages sent while the sandbox was paused into the queue, then tell the control plane. */
  const pickUpMessages = async () => {
    const res = await call(`/api/runner/inbox?threadId=${encodeURIComponent(threadId)}`, { method: "GET" });
    if (!res.ok) return;
    const inbox = RunnerInbox.safeParse(await res.json().catch(() => ({})));
    if (!inbox.success || inbox.data.messages.length === 0) return;
    for (const m of inbox.data.messages) runner.sendMessage(m.text, m.clientMsgId);
    await call("/api/runner/inbox", { method: "POST", body: { threadId, clientMsgIds: inbox.data.messages.map(m => m.clientMsgId) } });
  };

  const once = async () => {
    try {
      await syncHistory(false).catch(err => opts.log?.(`history upload failed: ${err instanceof Error ? err.message : String(err)}`));
      const t = runner.thread;
      if (t.status === "running") drained = false;
      // Sampled on every beat so CPU use is measured while the agent works too.
      const busy = activity.sample();
      const load = activity.load();
      const body: RunnerHeartbeat = {
        threadId,
        status: t.status,
        latestSeq: t.latestSeq,
        idleSince: runner.idle,
        runnerVersion: opts.version,
        background: busy === null || t.status === "running" ? null : busy,
        ...(load ? { load } : {}),
        ...(drained ? { drained: true } : {}),
      };
      const res = await call("/api/runner/heartbeat", { method: "POST", body });
      if (!res.ok) {
        opts.log?.(`heartbeat rejected: HTTP ${res.status}`);
        return;
      }
      const parsed = HeartbeatResponse.safeParse(await res.json().catch(() => ({})));
      if (!parsed.success) return;
      if (parsed.data.pendingMessages > 0) await pickUpMessages().catch(err => opts.log?.(`could not pick up messages: ${String(err)}`));
      if (parsed.data.action === "shutdown") opts.onShutdown();
      else if (parsed.data.action === "drain" && !drained) {
        // A pause is coming: make sure everything the thread has is kept, then say so.
        await syncHistory(true);
        drained = true;
        again = true;
      }
    } catch (err) {
      opts.log?.(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const beat = async (): Promise<void> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await once();
      } while (again);
    })().finally(() => (inFlight = null));
    return inFlight;
  };

  const timer = setInterval(() => void beat(), opts.intervalMs ?? INTERVAL_MS);
  timer.unref?.();
  const off = runner.onStatus(() => void beat());
  void beat();
  return {
    stop() {
      clearInterval(timer);
      off();
    },
    beat,
  };
}
