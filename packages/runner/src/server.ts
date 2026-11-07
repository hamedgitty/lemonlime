import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, verifyToken, type ServerMessage } from "@lemonlime/protocol";
import type { ThreadRunner } from "./thread-runner.ts";

export interface ServerOptions {
  host: string;
  port: number;
  /** The thread's secret; client tokens must be signed with it. */
  threadSecret: string;
  version: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;

/** HTTP health endpoint + the thread's WebSocket. */
export function startServer(runner: ThreadRunner, opts: ServerOptions): Promise<RunningServer> {
  const http: Server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      const t = runner.thread;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, threadId: t.id, status: t.status, latestSeq: t.latestSeq, idleSince: runner.idle, version: opts.version, agentVersion: runner.agentVersion }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => handleConnection(ws, runner, opts));
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      const port = (http.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>(done => {
            for (const c of wss.clients) c.terminate();
            wss.close();
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
      case "approve":
        runner.answerApproval(msg.requestId, msg.decision);
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
