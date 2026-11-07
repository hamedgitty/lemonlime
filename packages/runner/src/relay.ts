import { randomUUID } from "node:crypto";
import type { RelayAnswer, RelayedRequest } from "@lemonlime/protocol";

/** How long a relayed call may wait for its answer. The control plane collects every minute. */
const ANSWER_TIMEOUT_MS = 3 * 60_000;
/** A call collected but not answered by then is offered again (the collector may have died). */
const REOFFER_AFTER_MS = 90_000;
/** Calls kept waiting at once; beyond this the oldest heartbeats are dropped (a newer one follows). */
const MAX_WAITING = 200;

export interface RelayResponse {
  status: number;
  body: unknown;
}

interface Waiting {
  request: RelayedRequest;
  takenAt: number | null;
  resolve(r: RelayResponse): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Relay mode, for sandboxes that can't reach the control plane: calls the runner would
 * make on the control plane wait here until the control plane collects them (take) and
 * hands back the answers (answer).
 */
export class Relay {
  private waiting = new Map<string, Waiting>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Queue a call and wait for its answer. */
  request(call: Omit<RelayedRequest, "id">, timeoutMs = ANSWER_TIMEOUT_MS): Promise<RelayResponse> {
    if (this.waiting.size >= MAX_WAITING) this.dropOldestHeartbeat();
    const id = randomUUID();
    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("the control plane didn't collect this call in time"));
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { request: { id, ...call }, takenAt: null, resolve, reject, timer });
    });
  }

  /** Calls the control plane hasn't taken yet (or took and never answered), oldest first. */
  take(max = 50): RelayedRequest[] {
    const now = this.now();
    const out: RelayedRequest[] = [];
    for (const w of this.waiting.values()) {
      if (out.length >= max) break;
      if (w.takenAt !== null && now - w.takenAt < REOFFER_AFTER_MS) continue;
      w.takenAt = now;
      out.push(w.request);
    }
    return out;
  }

  /** Answers from the control plane. Returns how many matched a waiting call. */
  answer(answers: readonly RelayAnswer[]): number {
    let matched = 0;
    for (const a of answers) {
      const w = this.waiting.get(a.id);
      if (!w) continue;
      this.waiting.delete(a.id);
      clearTimeout(w.timer);
      w.resolve({ status: a.status, body: a.body });
      matched++;
    }
    return matched;
  }

  get size(): number {
    return this.waiting.size;
  }

  private dropOldestHeartbeat(): void {
    for (const [id, w] of this.waiting) {
      if (!w.request.path.startsWith("/api/runner/heartbeat")) continue;
      this.waiting.delete(id);
      clearTimeout(w.timer);
      w.reject(new Error("dropped: a newer heartbeat is waiting"));
      return;
    }
  }
}

/** A fetch-like Response for a relayed answer, so callers handle both paths the same way. */
export function relayResponse(r: RelayResponse): Response {
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}
