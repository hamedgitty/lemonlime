import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, parseTerminalClientMessage, verifyToken, type ServerMessage, type TerminalServerMessage } from "@lemonlime/protocol";
import { TerminalSession, type SpawnPty } from "./terminal.ts";
import type { ThreadRunner } from "./thread-runner.ts";

export interface ServerOptions {
  host: string;
  port: number;
  /** The thread's secret; client tokens must be signed with it. */
  threadSecret: string;
  version: string;
  /** The thread's terminal: a shell in `cwd`. Without `spawn` (no PTY support), it says so. */
  terminal?: { cwd: string; spawn: SpawnPty | null };
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const TERMINAL_FRAME_BYTES = 256 * 1024;
/** Output sent at once to a terminal client; bigger bursts are split. */
const TERMINAL_CHUNK_CHARS = 64 * 1024;
/** A terminal client this far behind for this long is dropped; it reconnects and resumes. */
const TERMINAL_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const TERMINAL_SLOW_MS = 10_000;

/** HTTP health endpoint + the thread's WebSocket. */
export function startServer(runner: ThreadRunner, opts: ServerOptions): Promise<RunningServer> {
  const http: Server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      const t = runner.thread;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          threadId: t.id,
          status: t.status,
          latestSeq: t.latestSeq,
          idleSince: runner.idle,
          version: opts.version,
          agentVersion: runner.agentVersion,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_FRAME_BYTES });
  const terminal = opts.terminal?.spawn ? new TerminalSession(opts.terminal.spawn, opts.terminal.cwd) : null;
  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    if (path === "/ws") wss.handleUpgrade(req, socket, head, ws => handleConnection(ws, runner, opts));
    else if (path === "/terminal") terminalWss.handleUpgrade(req, socket, head, ws => handleTerminal(ws, runner, opts, terminal));
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      const port = (http.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>(done => {
            for (const c of [...wss.clients, ...terminalWss.clients]) c.terminate();
            wss.close();
            terminalWss.close();
            terminal?.close();
            http.close(() => done());
          }),
      });
    });
  });
}

function handleConnection(ws: WebSocket, runner: ThreadRunner, opts: ServerOptions): void {
  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  let unsubscribe: (() => void) | null = null;
  let authed = false;

  const helloTimer = setTimeout(() => {
    if (!authed) {
      send({ type: "error", code: "unauthorized", message: "No hello received" });
      ws.close(4401, "unauthorized");
    }
  }, HELLO_TIMEOUT_MS);

  ws.on("message", async raw => {
    const msg = parseClientMessage(raw.toString());
    if (!msg) {
      send({ type: "error", code: "bad_request", message: "Invalid message" });
      return;
    }

    if (!authed) {
      if (msg.type !== "hello") {
        send({ type: "error", code: "unauthorized", message: "Send hello first" });
        ws.close(4401, "unauthorized");
        return;
      }
      const result = await verifyToken(msg.token, opts.threadSecret);
      const thread = runner.thread;
      if (!result.ok || result.claims.scope !== "client" || result.claims.threadId !== thread.id) {
        send({ type: "error", code: "unauthorized", message: result.ok ? "Token is not valid for this thread" : `Token ${result.reason.replace("_", " ")}` });
        ws.close(4401, "unauthorized");
        return;
      }
      authed = true;
      clearTimeout(helloTimer);
      send({ type: "welcome", thread, latestSeq: thread.latestSeq, runnerVersion: opts.version });
      // Subscribe before replaying so nothing appended in between is lost; the
      // client drops anything at or below the seq it already has.
      const buffered: ServerMessage[] = [];
      let replaying = true;
      unsubscribe = runner.store.subscribe(event => {
        const m: ServerMessage = { type: "event", event };
        if (replaying) buffered.push(m);
        else send(m);
      });
      for (const event of runner.store.since(msg.resumeFrom)) send({ type: "event", event });
      replaying = false;
      for (const m of buffered) send(m);
      send({ type: "caught_up", latestSeq: runner.store.latestSeq });
      // Sign-in progress goes to live connections only; it is never part of history.
      const offLogin = runner.onLogin(u => send({ type: "login", ...u }));
      const offEvents = unsubscribe;
      unsubscribe = () => {
        offEvents?.();
        offLogin();
      };
      return;
    }

    switch (msg.type) {
      case "send_message":
        try {
          const r = runner.sendMessage(msg.text, msg.clientMsgId);
          send({ type: "ack", clientMsgId: r.clientMsgId, result: r.result });
        } catch (err) {
          send({ type: "error", code: "internal", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      case "interrupt":
        runner.interrupt();
        break;
      case "edit_queue": {
        const change =
          msg.action === "update"
            ? msg.text
              ? { action: "update" as const, text: msg.text }
              : null
            : msg.action === "move"
              ? msg.toIndex !== undefined
                ? { action: "move" as const, toIndex: msg.toIndex }
                : null
              : { action: msg.action };
        if (!change) send({ type: "error", code: "bad_request", message: `${msg.action} needs ${msg.action === "update" ? "text" : "toIndex"}` });
        else runner.editQueued(msg.clientMsgId, change);
        break;
      }
      case "approve":
        runner.answerApproval(msg.requestId, msg.decision);
        break;
      case "start_login":
        runner.startLogin();
        break;
      case "login_input":
        runner.loginInput(msg.text);
        break;
      case "cancel_login":
        runner.cancelLogin();
        break;
      case "ping":
        send({ type: "pong", ...(msg.t !== undefined ? { t: msg.t } : {}) });
        break;
      case "hello":
        send({ type: "error", code: "bad_request", message: "Already authenticated" });
        break;
    }
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    unsubscribe?.();
  });
  ws.on("error", () => ws.terminate());
}

function handleTerminal(ws: WebSocket, runner: ThreadRunner, opts: ServerOptions, terminal: TerminalSession | null): void {
  let slowSince: number | null = null;
  const send = (m: TerminalServerMessage) => {
    if (ws.readyState !== ws.OPEN) return;
    // A client that can't keep up is dropped rather than buffered without limit.
    if (ws.bufferedAmount > TERMINAL_MAX_BUFFERED_BYTES) {
      slowSince ??= Date.now();
      if (Date.now() - slowSince > TERMINAL_SLOW_MS) ws.close(4408, "too slow");
      if (m.type === "output") return;
    } else slowSince = null;
    ws.send(JSON.stringify(m));
  };
  const sendOutput = (data: string, end: number) => {
    for (let i = 0; i < data.length; i += TERMINAL_CHUNK_CHARS) {
      const part = data.slice(i, i + TERMINAL_CHUNK_CHARS);
      send({ type: "output", data: part, end: end - data.length + i + part.length });
    }
  };
  let authed = false;
  let unsubscribe: (() => void) | null = null;
  const helloTimer = setTimeout(() => {
    if (!authed) ws.close(4401, "unauthorized");
  }, HELLO_TIMEOUT_MS);

  ws.on("message", async raw => {
    const msg = parseTerminalClientMessage(raw.toString());
    if (!msg) return send({ type: "error", code: "bad_request", message: "Invalid message" });
    if (!authed) {
      if (msg.type !== "hello") {
        send({ type: "error", code: "unauthorized", message: "Send hello first" });
        return ws.close(4401, "unauthorized");
      }
      const result = await verifyToken(msg.token, opts.threadSecret);
      if (!result.ok || result.claims.scope !== "client" || result.claims.threadId !== runner.thread.id) {
        send({ type: "error", code: "unauthorized", message: "Token is not valid for this thread" });
        return ws.close(4401, "unauthorized");
      }
      authed = true;
      clearTimeout(helloTimer);
      if (!terminal) {
        send({ type: "error", code: "unavailable", message: "This runner can't open a terminal on this computer." });
        return ws.close(1011, "unavailable");
      }
      terminal.resize(msg.cols, msg.rows);
      terminal.start();
      const { reset, data } = terminal.replay(msg.resumeFrom, msg.shell);
      send({ type: "ready", reset, running: terminal.running, shell: terminal.generation });
      if (data) sendOutput(data, terminal.end);
      unsubscribe = terminal.subscribe({
        output: sendOutput,
        exit: code => send({ type: "exit", code }),
        restarted: shell => send({ type: "restarted", shell }),
      });
      return;
    }
    if (!terminal) return;
    switch (msg.type) {
      case "input":
        terminal.write(msg.data);
        break;
      case "resize":
        terminal.resize(msg.cols, msg.rows);
        break;
      case "restart":
        terminal.start();
        break;
      case "hello":
        break;
    }
  });
  ws.on("close", () => {
    clearTimeout(helloTimer);
    unsubscribe?.();
  });
}
