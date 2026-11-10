import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import WebSocket from "ws";

/** Biggest request head we wait for before deciding; real ones are far smaller. */
const MAX_HEAD_BYTES = 32 * 1024;

/**
 * Is this the start of a request meant for our own address? A page on another site can
 * point a browser at 127.0.0.1 (DNS rebinding, or a fetch/WebSocket from that page), so
 * the Host must be this port on loopback, and any Origin must be too.
 *
 * `Origin: null` names nobody: a page that keeps its address to itself sends it with its
 * own form posts, and so does a sandboxed frame or a `data:` page on any other site. It is
 * taken only when the browser also says the request came from this same address
 * (`Sec-Fetch-Site: same-origin`, which browsers send to loopback and a page can't set
 * itself). A WebSocket always names the page that opened it, so `null` there is never ours.
 */
export function allowedRequest(head: string, localPort: number): { ok: true } | { ok: false; why: string } {
  if (!/^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/.test(head)) return { ok: false, why: "not an HTTP request" };
  const headers = new Map<string, string>();
  for (const line of head.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const mine = [`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`];
  if (!mine.includes((headers.get("host") ?? "").toLowerCase())) return { ok: false, why: "wrong Host" };
  const origin = (headers.get("origin") ?? "").toLowerCase();
  const sameAddress = (headers.get("sec-fetch-site") ?? "").toLowerCase() === "same-origin";
  const socket = (headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  const fromOurs = origin === "null" ? sameAddress && !socket : !origin || mine.some(h => origin === `http://${h}`);
  if (!fromOurs) return { ok: false, why: "request from another site" };
  return { ok: true };
}

export interface TunnelOptions {
  /** The runner's thread WebSocket URL (…/ws); the tunnel is next to it. */
  runnerUrl: string;
  /** The preview port inside the sandbox. */
  port: number;
  /** Where to listen on this computer; 0 picks a free port. */
  localPort?: number;
  /** A current client token (they expire; the app keeps it fresh). */
  token: () => string;
  WebSocketImpl?: typeof WebSocket;
}

export interface RunningTunnel {
  port: number;
  close(): Promise<void>;
}

/**
 * Serve a cloud preview on 127.0.0.1: each connection becomes one WebSocket to the
 * runner's `/tunnel`, carrying the raw bytes, so plain HTTP, WebSockets and server-sent
 * events all work. Nothing listens beyond loopback, and no URL leaves this computer.
 */
export function startTunnel(o: TunnelOptions): Promise<RunningTunnel> {
  const url = `${o.runnerUrl.replace(/\/ws(\?.*)?$/, "")}/tunnel?port=${o.port}`;
  const WS = o.WebSocketImpl ?? WebSocket;
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let head = Buffer.alloc(0);
    let ws: WebSocket | null = null;
    const pending: Buffer[] = [];

    const refuse = (why: string) => {
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nLemonLime preview: ${why}.\n`);
    };
    const connect = () => {
      const local = (server.address() as AddressInfo).port;
      const verdict = allowedRequest(head.toString("latin1"), local);
      if (!verdict.ok) return refuse(verdict.why);
      ws = new WS(url);
      ws.binaryType = "nodebuffer";
      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "hello", token: o.token() }));
        ws!.send(head, { binary: true });
        for (const b of pending.splice(0)) ws!.send(b, { binary: true });
      });
      ws.on("message", (data: Buffer) => socket.write(data));
      ws.on("close", () => socket.end());
      ws.on("error", () => socket.destroy());
    };

    socket.on("data", (d: Buffer) => {
      if (ws) {
        if (ws.readyState === ws.OPEN) ws.send(d, { binary: true });
        else pending.push(d);
        return;
      }
      head = Buffer.concat([head, d]);
      if (head.includes("\r\n\r\n")) connect();
      else if (head.length > MAX_HEAD_BYTES) refuse("request too large");
    });
    socket.on("close", () => ws?.close());
    socket.on("error", () => ws?.close());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.localPort ?? 0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>(done => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}
