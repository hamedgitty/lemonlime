/**
 * The address a connection came from, on plain Node. A route handler never sees the
 * connection itself, so the app's own server (server.ts) writes its address into a header
 * on every request, replacing whatever the caller sent under that name, and says here that
 * it does. Under a server that doesn't, the header could be anyone's, so it is ignored.
 */
export const SOCKET_ADDRESS_HEADER = "x-lemonlime-socket-address";

/** Set once this process's server writes the header itself. Shared through the process, like the server and the routes are. */
const WRITTEN_BY_SERVER = Symbol.for("lemonlime.socket-address");

/** For the Node server, before it hands a request on: write down where the connection came from. */
export function noteSocketAddress(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }): void {
  (globalThis as Record<symbol, unknown>)[WRITTEN_BY_SERVER] = true;
  const address = req.socket.remoteAddress;
  if (address) req.headers[SOCKET_ADDRESS_HEADER] = address;
  else delete req.headers[SOCKET_ADDRESS_HEADER];
}

/** Where the connection came from, when this process's own server wrote it down; otherwise null. */
export function socketAddress(headers: Headers): string | null {
  if (!(globalThis as Record<symbol, unknown>)[WRITTEN_BY_SERVER]) return null;
  return headers.get(SOCKET_ADDRESS_HEADER);
}
