import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LINK_FRAME_MAX_BYTES, PHONE_FRAME_MAX_BYTES, deriveBridgeKey } from "@lemonlime/protocol";
import { BridgeHub, bridgePath, pendingPeer, type BridgeControl, type Peer } from "./phone-bridge.ts";

/**
 * The phone bridge on Node: an in-process hub behind apps/web/server.ts. Only for a
 * single Node process (the Docker Compose setup); several processes would each have
 * their own hub and miss each other's links.
 */
export interface NodePhoneBridge {
  /** Take a WebSocket upgrade for /api/phone/…; false if the path isn't the bridge's. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  control: BridgeControl;
  hub: BridgeHub<WebSocket>;
  close(): void;
}

export function createNodePhoneBridge(opts: { masterSecret: () => string; now?: () => number; sweepMs?: number }): NodePhoneBridge {
  const peers = new Map<WebSocket, Peer>();
  const now = opts.now ?? Date.now;
  let key: Promise<string> | null = null;
  const hub = new BridgeHub<WebSocket>(
    {
      sockets: () => peers.keys(),
      peer: s => peers.get(s) ?? null,
      setPeer: (s, p) => {
        if (peers.has(s)) peers.set(s, p);
      },
      now,
      newId: () => crypto.randomUUID(),
    },
    () => (key ??= deriveBridgeKey(opts.masterSecret())),
  );
  // Separate servers so each kind of socket gets its own frame cap from `ws` too.
  const linkWss = new WebSocketServer({ noServer: true, maxPayload: LINK_FRAME_MAX_BYTES });
  const phoneWss = new WebSocketServer({ noServer: true, maxPayload: PHONE_FRAME_MAX_BYTES });
  const timer = setInterval(() => hub.sweep(), opts.sweepMs ?? 2000);
  timer.unref?.();

  const accept = (ws: WebSocket, peer: Peer) => {
    peers.set(ws, peer);
    ws.on("message", (raw, binary) => {
      if (binary) return ws.close(1003, "text only");
      void hub.message(ws, raw.toString());
    });
    ws.on("close", () => {
      hub.closed(ws);
      peers.delete(ws);
    });
    ws.on("error", () => ws.terminate());
  };

  return {
    hub,
    handleUpgrade(req, socket, head) {
      const path = bridgePath(new URL(req.url ?? "/", "http://bridge").pathname);
      if (!path) return false;
      const wss = path.kind === "link" ? linkWss : phoneWss;
      wss.handleUpgrade(req, socket, head, ws => accept(ws, pendingPeer(path, now())));
      return true;
    },
    control: {
      linked: async computerId => hub.linked(computerId),
      kill: async computerId => {
        hub.kill(computerId);
      },
    },
    close() {
      clearInterval(timer);
      for (const ws of peers.keys()) ws.terminate();
      linkWss.close();
      phoneWss.close();
    },
  };
}
