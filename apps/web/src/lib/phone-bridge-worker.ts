import { LINK_PING, LINK_PONG, deriveBridgeKey } from "@lemonlime/protocol";
import { BridgeHub, bridgePath, pendingPeer, type Peer } from "./phone-bridge.ts";
import { leftAsPlaceholder, placeholderError } from "./placeholder-secret.ts";

/**
 * The phone bridge on Cloudflare Workers: one Durable Object per computer (named by its
 * id), exported from worker.ts and bound as PHONE_BRIDGE. Sockets use the hibernation API,
 * so an idle bridge costs nothing while the sockets stay open; each socket keeps its peer
 * in its attachment, and the desktop app's pings are answered without waking the object.
 */

interface HibernatingSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface DurableObjectStateLike {
  acceptWebSocket(ws: HibernatingSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatingSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
  getWebSocketAutoResponseTimestamp?(ws: HibernatingSocket): Date | null;
  storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> };
}

declare const WebSocketPair: { new (): { 0: HibernatingSocket & WebSocket; 1: HibernatingSocket } };
declare const WebSocketRequestResponsePair: (new (request: string, response: string) => unknown) | undefined;

/** The key tickets are checked with. A token secret left as the placeholder is refused outside development, as it is everywhere else. */
function bridgeKey(env: Record<string, unknown>): Promise<string> {
  const secret = String(env.LEMONLIME_TOKEN_SECRET ?? "");
  if (env.NODE_ENV !== "development" && leftAsPlaceholder(secret)) return Promise.reject(placeholderError("LEMONLIME_TOKEN_SECRET"));
  return deriveBridgeKey(secret);
}

export class PhoneBridge {
  private readonly state: DurableObjectStateLike;
  private readonly hub: BridgeHub<HibernatingSocket>;

  constructor(state: DurableObjectStateLike, env: Record<string, unknown>) {
    this.state = state;
    let key: Promise<string> | null = null;
    this.hub = new BridgeHub<HibernatingSocket>(
      {
        sockets: () => state.getWebSockets(),
        peer: s => (s.deserializeAttachment() as Peer | null) ?? null,
        setPeer: (s, p) => s.serializeAttachment(p),
        lastPing: s => state.getWebSocketAutoResponseTimestamp?.(s)?.getTime() ?? 0,
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      () => (key ??= bridgeKey(env)),
    );
    if (typeof WebSocketRequestResponsePair === "function") state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair(LINK_PING, LINK_PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Only the control plane's own routes reach these (worker.ts forwards /api/phone/… only).
    if (url.pathname === "/internal/status") {
      return Response.json({ linked: this.hub.linked(url.searchParams.get("computer") ?? "") });
    }
    if (url.pathname === "/internal/kill" && request.method === "POST") {
      const closed = this.hub.kill(url.searchParams.get("computer") ?? "");
      return Response.json({ closed });
    }
    const path = bridgePath(url.pathname);
    if (!path) return new Response("Not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment(pendingPeer(path, Date.now()));
    await this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  async webSocketMessage(ws: HibernatingSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return ws.close(1003, "text only");
    await this.hub.message(ws, message);
    await this.schedule();
  }

  async webSocketClose(ws: HibernatingSocket): Promise<void> {
    this.hub.closed(ws);
    await this.schedule();
  }

  async webSocketError(ws: HibernatingSocket): Promise<void> {
    this.hub.closed(ws);
    await this.schedule();
  }

  async alarm(): Promise<void> {
    await this.schedule();
  }

  /** Sweep, then wake again at the next deadline (expiry, idle, hello timeout). */
  private async schedule(): Promise<void> {
    const next = this.hub.sweep();
    if (next === null) return;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > next) await this.state.storage.setAlarm(next);
  }
}
