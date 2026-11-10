/**
 * The control plane on plain Node, with phone access: Next.js plus the in-process phone
 * bridge, which needs WebSockets that `next start` can't take (docs/phone-access.md).
 *
 *   node server.ts          # production (after `next build`), like `next start`
 *   node server.ts --dev    # development, like `next dev`
 *
 * Listens on PORT (default 3000) on every address; set LEMONLIME_LISTEN_HOST to narrow that
 * (not HOSTNAME: Docker sets it to the container's name).
 * Needs Node 22.18 or newer (it runs this TypeScript file directly).
 */
import { createServer } from "node:http";
import next from "next";
import { createNodePhoneBridge } from "./src/lib/phone-bridge-node.ts";
import { registerNodeBridge } from "./src/lib/phone-bridge.ts";
import { leftAsPlaceholder, placeholderError } from "./src/lib/placeholder-secret.ts";
import { noteSocketAddress } from "./src/lib/socket-address.ts";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT) || 3000;
const hostname = process.env.LEMONLIME_LISTEN_HOST || "0.0.0.0";

const app = next({ dev, port, hostname });
await app.prepare();
const handle = app.getRequestHandler();
const upgradeNext = app.getUpgradeHandler();

// Read after prepare(), which loads .env files.
const bridge = createNodePhoneBridge({
  masterSecret: () => {
    const secret = process.env.LEMONLIME_TOKEN_SECRET;
    if (!secret) throw new Error("LEMONLIME_TOKEN_SECRET is not set.");
    if (!dev && leftAsPlaceholder(secret)) throw placeholderError("LEMONLIME_TOKEN_SECRET");
    return secret;
  },
});
registerNodeBridge(bridge.control);

// Each request carries the address its connection came from, so callers can be told apart
// without believing anything they sent (see src/lib/socket-address.ts).
const server = createServer((req, res) => {
  noteSocketAddress(req);
  void handle(req, res);
});
server.on("upgrade", (req, socket, head) => {
  if (!bridge.handleUpgrade(req, socket, head)) void upgradeNext(req, socket, head);
});
server.listen(port, hostname, () => {
  console.log(`[lemonlime] ready on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}${dev ? " (dev)" : ""}, with phone access`);
});
