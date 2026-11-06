import { parseServerMessage, type ClientMessage, type Thread, type ThreadEvent } from "@lemonlime/protocol";

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

  /** Send a user message. Queued if the connection is not live yet. */
  send(text: string, clientMsgId?: string): void {
    this.post({ type: "send_message", text, ...(clientMsgId ? { clientMsgId } : {}) });
  }

  /** Stop the agent's current turn. */
  interrupt(): void {
    this.post({ type: "interrupt" });
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
          this.opts.onEvent?.(msg.event);
          break;
        case "caught_up":
          this.live = true;
          this.setState("live");
          for (const m of this.pending.splice(0)) ws.send(JSON.stringify(m));
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
