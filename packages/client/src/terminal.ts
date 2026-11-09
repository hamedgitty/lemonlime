import { parseTerminalServerMessage, TERMINAL_MAX_INPUT_CHARS, type TerminalClientMessage } from "@lemonlime/protocol";

export type TerminalState = "connecting" | "live" | "reconnecting" | "exited" | "unavailable" | "closed";

export interface TerminalClientOptions {
  /** The runner's terminal socket, e.g. ws://127.0.0.1:7420/terminal */
  url: string;
  token: string | (() => Promise<string>);
  /** Which of the thread's terminals (see MAX_TERMINALS); the runner's default when left out. */
  terminal?: string;
  /** This terminal runs one of the project's scripts (by id); `restart` runs it. */
  script?: string;
  cols: number;
  rows: number;
  WebSocketImpl?: typeof WebSocket;
  /** Output to write to the screen. */
  onData: (data: string) => void;
  /** Clear the screen: what follows is the whole recent output, or a new shell. */
  onReset?: () => void;
  onState?: (state: TerminalState, detail?: string) => void;
  /** The shell's name (e.g. "zsh"), once the runner says. */
  onName?: (name: string) => void;
  maxBackoffMs?: number;
}

/** Runner WebSocket URL for the thread (…/ws) → its terminal socket (…/terminal). */
export function terminalUrl(threadUrl: string): string {
  return threadUrl.replace(/\/ws(\?|$)/, "/terminal$1");
}

/**
 * The thread's terminal. Reconnects with backoff and resumes from the last output it got,
 * so the screen never shows gaps or repeats; if the runner no longer has that output, it
 * clears and redraws from what it kept.
 */
export class TerminalClient {
  private ws: WebSocket | null = null;
  private shell: number | undefined;
  private end: number | undefined;
  private size: { cols: number; rows: number };
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private live = false;
  private killWhenReady = false;

  constructor(private readonly opts: TerminalClientOptions) {
    this.size = { cols: opts.cols, rows: opts.rows };
  }

  connect(): void {
    this.closedByUser = false;
    void this.open();
  }

  /** Keystrokes or a paste; big pastes are split to fit the runner's limit. */
  write(data: string): void {
    for (let i = 0; i < data.length; i += TERMINAL_MAX_INPUT_CHARS) this.post({ type: "input", data: data.slice(i, i + TERMINAL_MAX_INPUT_CHARS) });
  }

  resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    this.post({ type: "resize", cols, rows });
  }

  /** Start a new shell after the last one exited. */
  restart(): void {
    this.post({ type: "restart" });
  }

  /** End this terminal's shell for good (its tab was closed), then disconnect. */
  kill(): void {
    if (this.live && this.ws?.readyState === 1) {
      this.post({ type: "close" });
      this.close();
    } else this.killWhenReady = true; // still connecting: close it once the runner answers
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.opts.onState?.("closed");
  }

  private post(m: TerminalClientMessage): void {
    if (this.live && this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private async open(): Promise<void> {
    this.opts.onState?.(this.attempts === 0 ? "connecting" : "reconnecting");
    let token: string;
    try {
      token = typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
    } catch {
      return this.retry();
    }
    if (this.closedByUser) return;
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    const ws = new WS(this.opts.url);
    this.ws = ws;
    this.live = false;
    let unavailable = false;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          token,
          ...this.size,
          ...(this.opts.terminal ? { terminal: this.opts.terminal } : {}),
          ...(this.opts.script ? { script: this.opts.script } : {}),
          ...(this.shell !== undefined ? { shell: this.shell } : {}),
          ...(this.end !== undefined ? { resumeFrom: this.end } : {}),
        } satisfies TerminalClientMessage),
      );
    ws.onmessage = ev => {
      const msg = parseTerminalServerMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (!msg) return;
      switch (msg.type) {
        case "ready":
          this.attempts = 0;
          this.live = true;
          this.shell = msg.shell;
          if (this.killWhenReady) return this.kill();
          if (msg.name) this.opts.onName?.(msg.name);
          if (msg.reset) this.opts.onReset?.();
          this.opts.onState?.(msg.running ? "live" : "exited");
          break;
        case "output":
          this.end = msg.end;
          this.opts.onData(msg.data);
          break;
        case "exit":
          this.opts.onState?.("exited", msg.code === null ? undefined : `exit code ${msg.code}`);
          break;
        case "restarted":
          this.shell = msg.shell;
          this.end = 0;
          this.opts.onReset?.();
          this.opts.onState?.("live");
          break;
        case "error":
          if (msg.code === "unavailable" || msg.code === "limit") {
            unavailable = true;
            this.opts.onState?.("unavailable", msg.message);
          }
          break;
      }
    };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.live = false;
      if (unavailable || this.closedByUser) return;
      // The terminal was closed for good, from this app or another.
      if (ev?.code === 4410) {
        this.opts.onState?.("closed");
        return;
      }
      // Its token ran out (4001): reconnect at once with a fresh one.
      if (ev?.code === 4001) {
        this.timer = setTimeout(() => void this.open(), 0);
        return;
      }
      this.retry();
    };
  }

  private retry(): void {
    if (this.closedByUser) return;
    this.opts.onState?.("reconnecting");
    const delay = Math.min(this.opts.maxBackoffMs ?? 10_000, 500 * 2 ** this.attempts++);
    this.timer = setTimeout(() => void this.open(), delay);
  }
}
