import { parseServerMessage, type ClientMessage, type SideChatSummary, type Thread, type ThreadEvent } from "@lemonlime/protocol";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

export interface RunnerClientOptions {
  /** Runner WebSocket URL, e.g. ws://127.0.0.1:7420/ws */
  url: string;
  /** A token, or a function that returns a fresh one (called on every (re)connect). */
  token: string | (() => Promise<string>);
  /** Resume after this seq (events you already have). Defaults to 0 = full history. */
  resumeFrom?: number;
  /** Supply a WebSocket implementation outside the browser (e.g. `ws` in Node). */
  WebSocketImpl?: typeof WebSocket;
  onEvent?: (event: ThreadEvent) => void;
  onWelcome?: (thread: Thread, latestSeq: number) => void;
  onState?: (state: ConnectionState) => void;
  onError?: (message: string, code?: string) => void;
  /** Sign-in progress (cloud sandboxes). Never part of the history. */
  onLogin?: (update: { state: "starting" | "open_url" | "needs_input" | "done" | "failed"; url?: string; code?: string; message?: string }) => void;
  /** The runner accepted a message: it started a turn, was queued, or was a repeat. */
  onAck?: (clientMsgId: string, result: "started" | "queued" | "duplicate") => void;
  /** Side chats (never part of the thread's history). */
  onSideChats?: (chats: SideChatSummary[]) => void;
  onSideEvent?: (sideId: string, event: ThreadEvent) => void;
  onSideHistory?: (sideId: string, events: ThreadEvent[]) => void;
  onSideStarted?: (sideId: string, requestId?: string) => void;
  /** Max delay between reconnect attempts. */
  maxBackoffMs?: number;
}

/**
 * Keeps a live connection to one runner. Reconnects with backoff and resumes from
 * the last event it saw, so callers never get gaps or duplicates.
 */
export class RunnerClient {
  private ws: WebSocket | null = null;
  private lastSeq: number;
  private attempts = 0;
  private closedByUser = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: ClientMessage[] = [];
  /** Messages sent but not yet acknowledged; resent after a reconnect (the runner ignores repeats). */
  private readonly unacked = new Map<string, ClientMessage>();
  private live = false;

  constructor(private readonly opts: RunnerClientOptions) {
    this.lastSeq = opts.resumeFrom ?? 0;
  }

  /** Highest event seq received so far. */
  get seq(): number {
    return this.lastSeq;
  }

  connect(): void {
    this.closedByUser = false;
    void this.open();
  }

  /**
   * Send a user message and return its id. Held until the connection is live, and
   * resent after a reconnect until the runner acknowledges it. The runner never runs the
   * same id twice, and queues messages that arrive while the agent is busy.
   */
  send(text: string, clientMsgId: string = newId()): string {
    const msg: ClientMessage = { type: "send_message", text, clientMsgId };
    this.unacked.set(clientMsgId, msg);
    this.post(msg);
    return clientMsgId;
  }

  /**
   * Try to reconnect now instead of waiting for the next retry, e.g. after the computer
   * wakes from sleep or the network comes back. Does nothing while connected.
   */
  reconnectNow(): void {
    if (this.closedByUser || this.live) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws && this.ws.readyState <= 1) return; // already connecting
    this.attempts = Math.max(1, this.attempts);
    void this.open();
  }

  /** Stop the agent's current turn. */
  interrupt(): void {
    this.post({ type: "interrupt" });
  }

  /** Sign the agent in to the user's own account, inside the sandbox. */
  startLogin(): void {
    this.post({ type: "start_login" });
  }

  /** The code the sign-in page showed, pasted back. */
  loginInput(text: string): void {
    this.post({ type: "login_input", text });
  }

  cancelLogin(): void {
    this.post({ type: "cancel_login" });
  }

  /** Change a message still waiting in the queue (see ClientEditQueue). */
  editQueued(
    clientMsgId: string,
    change: { action: "update"; text: string } | { action: "remove" } | { action: "move"; toIndex: number } | { action: "send_now" },
  ): void {
    this.post({ type: "edit_queue", clientMsgId, ...change });
  }

  /** Go back to the user message at `toSeq`, optionally putting files back as they were then. */
  rewind(toSeq: number, restoreFiles: boolean): void {
    this.post({ type: "rewind", toSeq, restoreFiles });
  }

  /** Ask the agent to shrink its conversation (Claude Code). */
  compact(): void {
    this.post({ type: "compact" });
  }

  /** Ask in a side chat (a new one without `sideId`). The chat's id arrives in onSideStarted. */
  sideAsk(text: string, sideId?: string, requestId: string = newId()): string {
    this.post({ type: "side_ask", text, ...(sideId ? { sideId } : {}), requestId });
    return requestId;
  }

  sidePin(sideId: string, pinned: boolean): void {
    this.post({ type: "side_pin", sideId, pinned });
  }

  sideClose(sideId: string): void {
    this.post({ type: "side_close", sideId });
  }

  sideOpen(sideId: string): void {
    this.post({ type: "side_open", sideId });
  }

  /** Answer an approval request from the agent. */
  approve(requestId: string, decision: "allow" | "deny"): void {
    this.post({ type: "approve", requestId, decision });
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000, "client closed");
    this.ws = null;
    this.setState("closed");
  }

  private post(msg: ClientMessage): void {
    if (this.live && this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
    else this.pending.push(msg);
  }

  private setState(s: ConnectionState): void {
    this.opts.onState?.(s);
  }

  private async open(): Promise<void> {
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");
    let token: string;
    try {
      token = typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
    } catch (err) {
      this.opts.onError?.(`Could not get a token: ${String(err)}`);
      return this.scheduleReconnect();
    }
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    const ws = new WS(this.opts.url);
    this.ws = ws;
    this.live = false;

    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token, resumeFrom: this.lastSeq } satisfies ClientMessage));
    ws.onmessage = ev => {
      const msg = parseServerMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (!msg) return;
      switch (msg.type) {
        case "welcome":
          this.attempts = 0;
          this.opts.onWelcome?.(msg.thread, msg.latestSeq);
          break;
        case "event":
          if (msg.event.seq <= this.lastSeq) return; // already have it
          this.lastSeq = msg.event.seq;
          // A recorded message is as good as an ack, in case the ack itself was lost.
          if (msg.event.type === "user_message" && msg.event.clientMsgId) this.unacked.delete(msg.event.clientMsgId);
          if (msg.event.type === "queue_update") for (const q of msg.event.queue) this.unacked.delete(q.clientMsgId);
          this.opts.onEvent?.(msg.event);
          break;
        case "caught_up": {
          this.live = true;
          this.setState("live");
          // Resend anything the runner may not have received, then whatever else was waiting.
          const waiting = this.pending.splice(0).filter(m => m.type !== "send_message");
          for (const m of this.unacked.values()) ws.send(JSON.stringify(m));
          for (const m of waiting) ws.send(JSON.stringify(m));
          break;
        }
        case "login": {
          const { type: _t, ...update } = msg;
          this.opts.onLogin?.(update);
          break;
        }
        case "ack":
          this.unacked.delete(msg.clientMsgId);
          this.opts.onAck?.(msg.clientMsgId, msg.result);
          break;
        case "side_chats":
          this.opts.onSideChats?.(msg.chats);
          break;
        case "side_event":
          this.opts.onSideEvent?.(msg.sideId, msg.event);
          break;
        case "side_history":
          this.opts.onSideHistory?.(msg.sideId, msg.events);
          break;
        case "side_started":
          this.opts.onSideStarted?.(msg.sideId, msg.requestId);
          break;
        case "error":
          this.opts.onError?.(msg.message, msg.code);
          if (msg.code === "unauthorized") this.closedByUser = typeof this.opts.token === "string";
          break;
        case "pong":
          break;
      }
    };
    ws.onclose = () => {
      this.live = false;
      if (this.ws === ws) this.ws = null;
      if (!this.closedByUser) this.scheduleReconnect();
      else this.setState("closed");
    };
    ws.onerror = () => {
      /* onclose follows and handles reconnecting */
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.attempts += 1;
    const max = this.opts.maxBackoffMs ?? 15_000;
    const delay = Math.min(max, 500 * 2 ** Math.min(this.attempts, 6)) * (0.75 + Math.random() * 0.5);
    this.setState("reconnecting");
    this.timer = setTimeout(() => void this.open(), delay);
  }
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export { TerminalClient, terminalUrl, type TerminalClientOptions, type TerminalState } from "./terminal.ts";
