import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ComputerRequest,
  DEFAULT_TERMINAL_ID,
  FILE_READ_MAX_BYTES,
  FILES_LIMIT_MAX,
  RelayAnswers,
  parseClientMessage,
  parseTerminalClientMessage,
  verifyToken,
  MAX_TOKEN_LIFETIME_SECONDS,
  PROJECT_FILE,
  type ResolvedScript,
  type VerifyResult,
  type ServerMessage,
  type TerminalServerMessage,
} from "@lemonlime/protocol";
import { TerminalPool, type SpawnPty, type TerminalSession } from "./terminal.ts";
import { PortWatcher } from "./port-watch.ts";
import { keysFromSecret, type ThreadKeys } from "./keys.ts";
import { ATTACHMENT_CHUNK_BYTES } from "./attachments.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { listWorkdirFiles, searchFiles } from "./composer.ts";
import { contentTypeFor, findWorkdirFile, resolveWorkdirFile } from "./files.ts";
import { handleGitApi } from "./git-api.ts";
import type { ThreadRunner } from "./thread-runner.ts";
import type { Relay } from "./relay.ts";

export interface ServerOptions {
  host: string;
  port: number;
  /** The thread's secret; client tokens must be signed with it. */
  threadSecret?: string;
  /** Or, when a keeper holds the secret (see keeper.ts), what to check tokens with. */
  keys?: ThreadKeys;
  version: string;
  /** The thread's terminal: a shell in `cwd`. Without `spawn` (no PTY support), it says so. */
  terminal?: { cwd: string; spawn: SpawnPty | null; /** Most shells at once (default MAX_TERMINALS). */ max?: number };
  /** Ports the runner itself uses, never offered for preview. */
  ownPorts?: number[];
  /** Relay mode: calls for the control plane wait here for it to collect them (see relay.ts). */
  relay?: Relay;
  /** Look for ports the thread's programs start listening on, while it's busy (see port-watch.ts). */
  watchPorts?: boolean;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 10_000;

const keysByOptions = new WeakMap<ServerOptions, Promise<ThreadKeys>>();
/** What this server checks tokens with: the keeper's, or ones made from the secret it was given. */
function keysFor(opts: ServerOptions, threadId: string): Promise<ThreadKeys> {
  let keys = keysByOptions.get(opts);
  if (!keys) {
    keys = opts.keys ? Promise.resolve(opts.keys) : keysFromSecret(threadId, opts.threadSecret ?? "");
    keysByOptions.set(opts, keys);
  }
  return keys;
}

/** A token signed with the thread secret (the user's apps, the relay), capped in lifetime. */
async function verifyUser(token: string, opts: ServerOptions, threadId: string): Promise<VerifyResult> {
  return capped(await (await keysFor(opts, threadId)).verify(token));
}

/** A token from the agent's own tools, signed with the agent key, capped in lifetime. */
async function verifyAgent(token: string, opts: ServerOptions, threadId: string): Promise<VerifyResult> {
  return capped(await verifyToken(token, (await keysFor(opts, threadId)).agentKey));
}

/**
 * A connection lives only as long as the token it opened with. When it runs out, the
 * connection is closed (code 4001) and the app reconnects at once with a fresh token, which
 * only someone still allowed to open the thread can get: removing a member cuts them off
 * within one token's lifetime instead of whenever they happen to disconnect.
 */
export const TOKEN_EXPIRED_CLOSE = 4001;
function closeAtExpiry(ws: WebSocket, exp: number): () => void {
  const timer = setTimeout(() => ws.close(TOKEN_EXPIRED_CLOSE, "token expired"), Math.max(0, exp * 1000 - Date.now()));
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Refuse tokens that claim to live longer than any LemonLime app makes them. */
function capped(result: VerifyResult): VerifyResult {
  if (result.ok && result.claims.exp > Math.floor(Date.now() / 1000) + MAX_TOKEN_LIFETIME_SECONDS + 60) return { ok: false, reason: "malformed" };
  return result;
}
const MAX_FRAME_BYTES = 1024 * 1024;
const TERMINAL_FRAME_BYTES = 256 * 1024;
/** Output sent at once to a terminal client; bigger bursts are split. */
const TERMINAL_CHUNK_CHARS = 64 * 1024;
/** A terminal client this far behind for this long is dropped; it reconnects and resumes. */
const TERMINAL_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/**
 * A thread client this far behind is disconnected rather than buffered without limit; it
 * reconnects and resumes from the last event it got, so nothing is lost.
 */
const THREAD_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Replaying history pauses whenever this much is waiting to go out, until the socket drains. */
const REPLAY_HIGH_WATER_BYTES = 1024 * 1024;

/** Resolves once the socket has sent most of what's queued, or has closed. */
function drained(ws: WebSocket): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount < REPLAY_HIGH_WATER_BYTES / 4) resolve();
      else setTimeout(check, 20);
    };
    check();
  });
}
const TERMINAL_SLOW_MS = 10_000;
/** Close code for a terminal socket whose terminal was closed for good (don't reconnect). */
const TERMINAL_CLOSED_CLOSE = 4410;

/**
 * What a phone (a `phone` token, through the control plane's phone bridge) may not do on a
 * thread that runs on the user's computer: answer the agent's requests for the computer,
 * or sign the agent in. Nor may it give the agent full access (see handleConnection).
 * Phone tokens open only the thread's WebSocket: the terminal, previews, files, uploads and
 * downloads all still want a `client` token.
 */
const PHONE_REFUSED = new Set<string>(["computer_result", "start_login", "login_input", "cancel_login"]);

/** HTTP health endpoint + the thread's WebSocket. */
export function startServer(runner: ThreadRunner, opts: ServerOptions): Promise<RunningServer> {
  const http: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    if (
      path === "/capabilities" ||
      path === "/files" ||
      path === "/file" ||
      path === "/commands" ||
      path.startsWith("/attachments") ||
      path === "/previews" ||
      path.startsWith("/subagents") ||
      path === "/computer" ||
      path.startsWith("/teleport") ||
      path.startsWith("/relay") ||
      path.startsWith("/git/")
    ) {
      void handleHttpApi(req, res, path, runner, opts).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      });
      return;
    }
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
          waitingApprovals: runner.waitingApprovals,
          agent: t.agent.kind,
          account: runner.currentAccount,
          limit: runner.limitStopped,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_FRAME_BYTES });
  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const terminals = opts.terminal?.spawn ? new TerminalPool(opts.terminal.spawn, opts.terminal.cwd, opts.terminal.max, undefined, runner.scriptEnv) : null;
  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    if (path === "/ws") wss.handleUpgrade(req, socket, head, ws => handleConnection(ws, runner, opts));
    else if (path === "/terminal") terminalWss.handleUpgrade(req, socket, head, ws => handleTerminal(ws, runner, opts, terminals, watcher));
    else if (path === "/tunnel") tunnelWss.handleUpgrade(req, socket, head, ws => handleTunnel(ws, req, runner, opts));
    else socket.destroy();
  });

  let listenPort = 0;
  const watcher = opts.watchPorts
    ? new PortWatcher({ ignore: () => [listenPort, ...(opts.ownPorts ?? [])], onChange: ports => runner.setListeningPorts(ports) })
    : null;
  const stopWatching = watcher ? runner.onStatus(s => watcher.busy(s === "running")) : () => {};

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      const port = (http.address() as AddressInfo).port;
      listenPort = port;
      resolve({
        port,
        close: () =>
          new Promise<void>(done => {
            for (const c of [...wss.clients, ...terminalWss.clients, ...tunnelWss.clients]) c.terminate();
            tunnelWss.close();
            wss.close();
            terminalWss.close();
            terminals?.closeAll();
            stopWatching();
            watcher?.stop();
            http.close(() => done());
          }),
      });
    });
  });
}

function handleConnection(ws: WebSocket, runner: ThreadRunner, opts: ServerOptions): void {
  const send = (m: ServerMessage) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > THREAD_MAX_BUFFERED_BYTES) {
      ws.close(4408, "too slow");
      return;
    }
    ws.send(JSON.stringify(m));
  };
  let unsubscribe: (() => void) | null = null;
  let authed = false;
  /** Reached through the phone bridge (a `phone` token): fewer powers, see PHONE_REFUSED. */
  let phone = false;
  let stopExpiry: () => void = () => {};

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
      const result = await verifyUser(msg.token, opts, runner.thread.id);
      const thread = runner.thread;
      if (!result.ok || (result.claims.scope !== "client" && result.claims.scope !== "phone") || result.claims.threadId !== thread.id) {
        send({ type: "error", code: "unauthorized", message: result.ok ? "Token is not valid for this thread" : `Token ${result.reason.replace("_", " ")}` });
        ws.close(4401, "unauthorized");
        return;
      }
      authed = true;
      phone = result.claims.scope === "phone";
      clearTimeout(helloTimer);
      stopExpiry = closeAtExpiry(ws, result.claims.exp);
      send({ type: "welcome", thread, latestSeq: thread.latestSeq, runnerVersion: opts.version, options: runner.currentOptions });
      // Subscribe before replaying so nothing appended in between is lost; the
      // client drops anything at or below the seq it already has.
      const buffered: ServerMessage[] = [];
      let replaying = true;
      unsubscribe = runner.store.subscribe(event => {
        const m: ServerMessage = { type: "event", event };
        if (replaying) buffered.push(m);
        else send(m);
      });
      for (const event of runner.store.since(msg.resumeFrom)) {
        send({ type: "event", event });
        // A long history goes out in steps, not all at once into memory.
        if (ws.bufferedAmount > REPLAY_HIGH_WATER_BYTES) await drained(ws);
        if (ws.readyState !== ws.OPEN) return;
      }
      replaying = false;
      for (const m of buffered) send(m);
      send({ type: "caught_up", latestSeq: runner.store.latestSeq });
      // Sign-in progress goes to live connections only; it is never part of history. Not to
      // a phone: signing the agent in is done at the computer.
      const offLogin = phone ? () => undefined : runner.onLogin(u => send({ type: "login", ...u }));
      // Side chats too: live only, never in the thread's history.
      send({ type: "side_chats", chats: runner.side.list() });
      const offSide = runner.side.subscribe((sideId, event) => send({ type: "side_event", sideId, event }));
      const offSideList = runner.side.onList(chats => send({ type: "side_chats", chats }));
      const offComputer = msg.computer && !phone ? runner.computer.addClient(send) : () => undefined;
      const offEvents = unsubscribe;
      unsubscribe = () => {
        offEvents?.();
        offLogin();
        offSide();
        offSideList();
        offComputer();
      };
      return;
    }

    if (phone && PHONE_REFUSED.has(msg.type)) {
      send({ type: "error", code: "bad_request", message: "That can only be done on the computer itself." });
      return;
    }
    if (phone && msg.type === "set_options" && msg.permission === "full" && runner.currentOptions.permission !== "full") {
      send({ type: "error", code: "bad_request", message: "Turn on full access on the computer itself." });
      return;
    }

    switch (msg.type) {
      case "send_message":
        try {
          const r = runner.sendMessage(msg.text, msg.clientMsgId, msg.attachments ?? []);
          send({ type: "ack", clientMsgId: r.clientMsgId, result: r.result });
        } catch (err) {
          send({ type: "error", code: "internal", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      case "interrupt":
        runner.interrupt();
        break;
      case "computer_result":
        runner.computer.answer(msg.requestId, { ok: msg.ok, output: msg.output });
        break;
      case "side_ask": {
        const r = runner.side.ask(msg.text, msg.sideId);
        if (typeof r === "string") send({ type: "side_started", sideId: r, ...(msg.requestId ? { requestId: msg.requestId } : {}) });
        else send({ type: "error", code: "bad_request", message: r.error });
        break;
      }
      case "side_pin":
        runner.side.pin(msg.sideId, msg.pinned);
        break;
      case "side_close":
        void runner.side.close(msg.sideId);
        break;
      case "side_open":
        send({ type: "side_history", sideId: msg.sideId, events: runner.side.history(msg.sideId) });
        break;
      case "rewind":
        void runner.rewind(msg.toSeq, msg.restoreFiles).then(r => {
          if ("error" in r) send({ type: "error", code: "bad_request", message: r.error });
        });
        break;
      case "offer_preview":
        if (!runner.offerListeningPort(msg.port)) send({ type: "error", code: "bad_request", message: "Nothing is listening on that port any more." });
        break;
      case "continue_after_restart": {
        const r = runner.continueAfterRestart();
        if ("error" in r) send({ type: "error", code: "bad_request", message: r.error });
        break;
      }
      case "compact":
        if (!runner.compact()) send({ type: "error", code: "bad_request", message: "This agent can't compact its conversation." });
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
      case "answer_question":
        runner.answerQuestion(msg.requestId, msg.answers);
        break;
      case "set_options": {
        const r = runner.setOptions({
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          ...(msg.reasoning !== undefined ? { reasoning: msg.reasoning } : {}),
          ...(msg.permission !== undefined ? { permission: msg.permission } : {}),
          ...(msg.fast !== undefined ? { fast: msg.fast } : {}),
        });
        if ("error" in r) send({ type: "error", code: "bad_request", message: r.error });
        break;
      }
      case "limit_action": {
        const action =
          msg.action === "switch_account"
            ? msg.accountId
              ? { action: "switch_account" as const, accountId: msg.accountId }
              : null
            : msg.action === "switch_agent"
              ? msg.agent
                ? { action: "switch_agent" as const, agent: msg.agent, model: msg.model ?? null }
                : null
              : { action: "wait" as const };
        if (!action) send({ type: "error", code: "bad_request", message: `${msg.action} needs ${msg.action === "switch_account" ? "accountId" : "agent"}` });
        else
          void runner.limitAction(action).then(r => {
            if ("error" in r) send({ type: "error", code: "bad_request", message: r.error });
          });
        break;
      }
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
    stopExpiry();
    unsubscribe?.();
  });
  ws.on("error", () => ws.terminate());
}

function handleTerminal(ws: WebSocket, runner: ThreadRunner, opts: ServerOptions, terminals: TerminalPool | null, watcher: PortWatcher | null): void {
  let terminal: TerminalSession | null = null;
  let terminalId = DEFAULT_TERMINAL_ID;
  let script: ResolvedScript | null = null;
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
  let stopExpiry: () => void = () => {};
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
      const result = await verifyUser(msg.token, opts, runner.thread.id);
      if (!result.ok || result.claims.scope !== "client" || result.claims.threadId !== runner.thread.id) {
        send({ type: "error", code: "unauthorized", message: "Token is not valid for this thread" });
        return ws.close(4401, "unauthorized");
      }
      authed = true;
      clearTimeout(helloTimer);
      stopExpiry = closeAtExpiry(ws, result.claims.exp);
      if (!terminals) {
        send({ type: "error", code: "unavailable", message: "This runner can't open a terminal on this computer." });
        return ws.close(1011, "unavailable");
      }
      terminalId = msg.terminal ?? DEFAULT_TERMINAL_ID;
      // A project script: its command comes from the runner's own copy of the project file, never from the app.
      if (msg.script) {
        const found = runner.projectScripts.scripts.find(x => x.id === msg.script);
        if (!found) {
          send({ type: "error", code: "unavailable", message: `This project has no script “${msg.script}” any more (see ${PROJECT_FILE}).` });
          return ws.close(1011, "no such script");
        }
        script = found;
      }
      terminal = terminals.open(terminalId, script ? { command: script.command } : {});
      if (!terminal) {
        send({ type: "error", code: "limit", message: `A thread can have ${terminals.max} terminals open at once. Close one first.` });
        return ws.close(1008, "too many terminals");
      }
      terminal.resize(msg.cols, msg.rows);
      // A script runs when asked (restart), never just because an app connected.
      if (terminal.command === null) terminal.start();
      const { reset, data } = terminal.replay(msg.resumeFrom, msg.shell);
      send({ type: "ready", reset, running: terminal.running, shell: terminal.generation, name: terminal.name });
      if (data) sendOutput(data, terminal.end);
      unsubscribe = terminal.subscribe({
        output: sendOutput,
        exit: code => send({ type: "exit", code }),
        restarted: shell => send({ type: "restarted", shell }),
        closed: () => ws.close(TERMINAL_CLOSED_CLOSE, "terminal closed"),
      });
      return;
    }
    if (!terminal) return;
    switch (msg.type) {
      case "input":
        terminal.write(msg.data);
        // Typing Enter may start a server: look for new ports for a while.
        if (msg.data.includes("\r")) watcher?.touch();
        break;
      case "resize":
        terminal.resize(msg.cols, msg.rows);
        break;
      case "restart":
        if (script) {
          // Pick up edits to the project file since the terminal opened.
          const now = runner.projectScripts.scripts.find(x => x.id === script!.id);
          if (now) script = now;
          if (!terminal.running) terminal.command = script.command;
          if (script.previewUrl) runner.offerScriptPreview(script.previewUrl, script.name, opts.ownPorts ?? []);
        }
        terminal.start();
        watcher?.touch();
        break;
      case "close":
        terminals?.close(terminalId);
        break;
      case "hello":
        break;
    }
  });
  ws.on("close", () => {
    clearTimeout(helloTimer);
    stopExpiry();
    unsubscribe?.();
  });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
  res.end(JSON.stringify(body));
}

/** The body, up to `max` bytes; null if it's bigger. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > max) {
        resolve(null);
        req.destroy();
      } else parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/**
 * `GET /capabilities`: what this thread's agent can be asked for. Attachments, with a
 * client token (`Authorization: Bearer`):
 * `POST /attachments` {id, name, size} starts an upload; `PUT /attachments/<id>?offset=N`
 * sends the next piece (up to 4 MB); `GET /attachments/<id>` says how much has arrived,
 * to resume after a dropped connection. `GET /attachments/<id>/image` sends a sent image
 * back, for the apps to show in the thread.
 */
async function handleHttpApi(req: IncomingMessage, res: ServerResponse, path: string, runner: ThreadRunner, opts: ServerOptions): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (path === "/relay" || path === "/relay/local") {
    if (!opts.relay) return reply(res, 404, { error: "not_found" });
    // /relay: the control plane collecting and answering calls (a relay token);
    // /relay/local: this sandbox's own git credential helper (a runner token).
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const scope = path === "/relay" ? "relay" : "runner";
    const auth = token ? await (scope === "relay" ? verifyUser(token, opts, runner.thread.id) : verifyAgent(token, opts, runner.thread.id)) : null;
    if (!auth?.ok || auth.claims.scope !== scope || auth.claims.threadId !== runner.thread.id) return reply(res, 401, { error: "unauthorized" });
    if (path === "/relay" && req.method === "GET") return reply(res, 200, { requests: opts.relay.take() });
    if (req.method !== "POST") return reply(res, 405, { error: "method_not_allowed" });
    const raw = await readBody(req, 8 * 1024 * 1024);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw?.toString() ?? "{}");
    } catch {
      return reply(res, 400, { error: "bad json" });
    }
    if (path === "/relay") {
      const answers = RelayAnswers.safeParse(parsed);
      if (!answers.success) return reply(res, 400, { error: "bad request" });
      return reply(res, 200, { matched: opts.relay.answer(answers.data.answers) });
    }
    // The git helper only ever asks for a repository token.
    const asked = (parsed as { path?: unknown }).path;
    if (typeof asked !== "string" || !/^\/api\/runner\/git-credentials\?[^#]*$/.test(asked)) return reply(res, 400, { error: "bad request" });
    const answer = await opts.relay
      .request({ method: "GET", path: asked, authorization: `Bearer ${token}` })
      .catch((err: Error) => ({ status: 504, body: { error: err.message } }));
    return reply(res, answer.status, answer.body ?? {});
  }
  if (path === "/computer" && req.method === "POST") {
    // From the cloud agent's own tools: a runner token signed with the agent key.
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const auth = token ? await verifyAgent(token, opts, runner.thread.id) : null;
    if (!auth?.ok || auth.claims.scope !== "runner" || auth.claims.threadId !== runner.thread.id) return reply(res, 401, { error: "unauthorized" });
    const body = await readBody(req, 64 * 1024);
    const parsed = ComputerRequest.safeParse(
      (() => {
        try {
          return JSON.parse(body?.toString() ?? "{}");
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) return reply(res, 400, { error: "bad request" });
    return reply(res, 200, await runner.computer.request(parsed.data));
  }
  if (path.startsWith("/subagents")) {
    // From the agents' own subagents MCP server: a runner token signed with the agent key.
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const auth = token ? await verifyAgent(token, opts, runner.thread.id) : null;
    if (!auth?.ok || auth.claims.scope !== "runner" || auth.claims.threadId !== runner.thread.id) return reply(res, 401, { error: "unauthorized" });
    const parent = new URL(req.url ?? "/", "http://runner").searchParams.get("parent") || null;
    if (path === "/subagents" && req.method === "GET") return reply(res, 200, { subagents: runner.subagents.list(parent) });
    const body = await readBody(req, 64 * 1024);
    let parsed: { requestId?: unknown; task?: unknown; id?: unknown; text?: unknown } = {};
    try {
      parsed = JSON.parse(body?.toString() ?? "{}") as typeof parsed;
    } catch {
      return reply(res, 400, { error: "bad json" });
    }
    if (path === "/subagents/spawn" && req.method === "POST") {
      const task = String(parsed.task ?? "").trim();
      const requestId = String(parsed.requestId ?? "").trim();
      if (!task || !requestId) return reply(res, 400, { error: "A subagent needs a task and a request_id." });
      const r = runner.subagents.spawn({ requestId: requestId.slice(0, 200), task, parentId: parent });
      return "error" in r ? reply(res, 409, r) : reply(res, 200, r);
    }
    if (path === "/subagents/message" && req.method === "POST") {
      const r = runner.subagents.message(String(parsed.id ?? ""), String(parsed.text ?? ""), parent);
      return r === true ? reply(res, 200, { ok: true }) : r === false ? reply(res, 404, { error: "No subagent with that id." }) : reply(res, 403, r);
    }
    return reply(res, 404, { error: "not_found" });
  }
  if (path === "/previews") {
    // From the agent's own `lemonlime-runner preview`: a runner token signed with the agent key.
    // The user's apps may list previews with their client token.
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const auth = token ? await verifyAgent(token, opts, runner.thread.id) : null;
    if (req.method === "GET") {
      const asClient = token && !auth?.ok ? await verifyUser(token, opts, runner.thread.id) : null;
      const ok =
        (auth?.ok && auth.claims.threadId === runner.thread.id) ||
        (asClient?.ok && asClient.claims.scope === "client" && asClient.claims.threadId === runner.thread.id);
      return ok ? reply(res, 200, { previews: runner.previews }) : reply(res, 401, { error: "unauthorized" });
    }
    if (!auth?.ok || auth.claims.scope !== "runner" || auth.claims.threadId !== runner.thread.id) return reply(res, 401, { error: "unauthorized" });
    const body = await readBody(req, 4096);
    let parsed: { port?: unknown; name?: unknown; remove?: unknown } = {};
    try {
      parsed = JSON.parse(body?.toString() ?? "{}") as typeof parsed;
    } catch {
      return reply(res, 400, { error: "bad json" });
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reply(res, 400, { error: "bad port" });
    if (port === req.socket.localPort || opts.ownPorts?.includes(port)) return reply(res, 400, { error: "That's the runner's own port." });
    runner.setPreview(port, parsed.remove === true ? null : String(parsed.name ?? ""));
    return reply(res, 200, { previews: runner.previews });
  }
  if (path === "/capabilities" && req.method === "GET") {
    const agent = runner.thread.agent;
    const now = runner.currentOptions;
    return reply(
      res,
      200,
      capabilitiesFor(agent.kind, {
        agentVersion: runner.agentVersion ?? null,
        ...(now.model ? { model: now.model } : {}),
        ...(now.reasoning ? { reasoning: now.reasoning } : {}),
        permission: now.permission,
      }),
    );
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const auth = token ? await verifyUser(token, opts, runner.thread.id) : null;
  if (!auth?.ok || auth.claims.scope !== "client" || auth.claims.threadId !== runner.thread.id) return reply(res, 401, { error: "unauthorized" });

  // The composer's `@` and `/` menus (see packages/protocol/src/composer.ts).
  if (path === "/files" && req.method === "GET") {
    const params = new URL(req.url ?? "/", "http://runner").searchParams;
    const limit = Math.min(FILES_LIMIT_MAX, Math.max(1, Number(params.get("limit")) || 50));
    const files = await listWorkdirFiles(runner.workdir).catch(() => [] as string[]);
    return reply(res, 200, searchFiles(files, (params.get("q") ?? "").slice(0, 200), limit));
  }
  // One file from the working folder, for the app's file tabs.
  if (path === "/file" && req.method === "GET") {
    const asked = new URL(req.url ?? "/", "http://runner").searchParams.get("path") ?? "";
    const found = await resolveWorkdirFile(runner.workdir, asked, FILE_READ_MAX_BYTES);
    if ("error" in found) return reply(res, found.status, { error: found.error });
    res.writeHead(200, {
      "content-type": contentTypeFor(found.path, found.data),
      "content-length": String(found.data.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...CORS,
    });
    res.end(found.data);
    return;
  }
  if (path === "/project-scripts" && req.method === "GET") return reply(res, 200, runner.projectScripts);
  // Whether a path the terminal printed is a file in the thread's folder, for clickable `path:line`.
  if (path === "/file-exists" && req.method === "GET") {
    const asked = new URL(req.url ?? "/", "http://runner").searchParams.get("path") ?? "";
    const found = await findWorkdirFile(runner.workdir, asked);
    return found ? reply(res, 200, { path: found }) : reply(res, 404, { error: "No such file." });
  }
  if (path === "/commands" && req.method === "GET") return reply(res, 200, { commands: runner.agentCommands });
  if (path.startsWith("/git/")) return handleGitApi(req, res, path, runner.review, { reply, readBody });
  if (path === "/teleport/export" && req.method === "POST") {
    try {
      return reply(res, 200, await runner.exportForTeleport());
    } catch (err) {
      return reply(res, 422, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const pack = /^\/teleport\/([0-9a-f-]{36})\/(bundle|history\.json)$/.exec(path);
  if (pack && req.method === "GET") {
    const file = runner.teleportFile(pack[1]!, pack[2] as "bundle" | "history.json");
    if (!file) return reply(res, 404, { error: "not found" });
    const all = readFileSync(file);
    const offset = Math.max(0, Number(new URL(req.url ?? "/", "http://runner").searchParams.get("offset")) || 0);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-total-bytes": String(all.length),
      "access-control-expose-headers": "x-total-bytes",
      ...CORS,
    });
    res.end(all.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES));
    return;
  }
  if (path === "/teleport/import" && req.method === "POST") {
    const body = await readBody(req, 16 * 1024);
    let p: { transferId?: unknown; checksum?: unknown; bundleUpload?: unknown; historyUpload?: unknown; from?: unknown } = {};
    try {
      p = JSON.parse(body?.toString() ?? "{}") as typeof p;
    } catch {
      return reply(res, 400, { error: "bad json" });
    }
    const fileOf = (uploadId: unknown) => {
      const u = typeof uploadId === "string" ? runner.attachments.get(uploadId) : null;
      return u?.done && u.path ? readFileSync(join(runner.workdir, u.path)) : null;
    };
    const history = fileOf(p.historyUpload);
    const bundle = p.bundleUpload ? fileOf(p.bundleUpload) : null;
    if (!history || (p.bundleUpload && !bundle)) return reply(res, 400, { error: "Upload the files first." });
    const r = await runner.importTeleport({
      transferId: String(p.transferId ?? ""),
      checksum: String(p.checksum ?? ""),
      bundle,
      history,
      from: p.from === "cloud" ? "the cloud" : "another computer",
    });
    return r.ok ? reply(res, 200, { ok: true, already: r.already }) : reply(res, r.status, { error: r.error });
  }
  const sent = /^\/attachments\/([^/]+)\/image$/.exec(path);
  if (sent && req.method === "GET") {
    const image = runner.attachments.image(sent[1]!);
    if ("error" in image) return reply(res, image.status, { error: image.error });
    res.writeHead(200, {
      "content-type": image.type,
      "content-length": String(image.size),
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      // Shown as an image only: an SVG opened on its own can't run anything.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...CORS,
    });
    res.end(readFileSync(image.path));
    return;
  }
  const id = path.split("/")[2];
  if (path === "/attachments" && req.method === "POST") {
    const body = await readBody(req, 16 * 1024);
    let parsed: { id?: unknown; name?: unknown; size?: unknown } = {};
    try {
      parsed = JSON.parse(body?.toString() ?? "{}") as typeof parsed;
    } catch {
      return reply(res, 400, { error: "bad json" });
    }
    const r = runner.attachments.begin(String(parsed.id ?? ""), String(parsed.name ?? ""), Number(parsed.size));
    return "error" in r ? reply(res, r.status, { error: r.error }) : reply(res, 200, r);
  }
  if (id && req.method === "GET") {
    const u = runner.attachments.get(id);
    return u ? reply(res, 200, u) : reply(res, 404, { error: "unknown upload" });
  }
  if (id && req.method === "PUT") {
    const offset = Number(new URL(req.url ?? "/", "http://runner").searchParams.get("offset"));
    const data = await readBody(req, ATTACHMENT_CHUNK_BYTES);
    if (!data) return reply(res, 413, { error: "piece too large" });
    const r = runner.attachments.write(id, offset, data);
    return "error" in r ? reply(res, r.status, r) : reply(res, 200, r);
  }
  return reply(res, 404, { error: "not_found" });
}

/**
 * One TCP connection to a preview port inside the sandbox, carried over a WebSocket: a
 * text hello with a client token, then binary frames both ways. Only ports the agent
 * offered, only on this machine's loopback.
 */
function handleTunnel(ws: WebSocket, req: IncomingMessage, runner: ThreadRunner, opts: ServerOptions): void {
  const port = Number(new URL(req.url ?? "/", "http://runner").searchParams.get("port"));
  let socket: Socket | null = null;
  let state: "hello" | "checking" | "open" = "hello";
  // Bytes the client sends while its token is being checked, written once connected.
  const early: Buffer[] = [];
  const timer = setTimeout(() => ws.close(4401, "unauthorized"), HELLO_TIMEOUT_MS);

  const open = () => {
    const s = createConnection({ host: "127.0.0.1", port });
    socket = s;
    state = "open";
    for (const b of early.splice(0)) s.write(b);
    s.on("data", d => {
      ws.send(d, { binary: true });
      if (ws.bufferedAmount > 4 * 1024 * 1024) {
        s.pause();
        const resume = setInterval(() => {
          if (ws.bufferedAmount < 1024 * 1024 || ws.readyState !== ws.OPEN) {
            clearInterval(resume);
            s.resume();
          }
        }, 20);
      }
    });
    s.on("close", () => ws.close(1000));
    s.on("error", () => ws.close(1011, "connection to the dev server failed"));
  };

  ws.on("message", (data, binary) => {
    if (state === "open") {
      if (binary) socket?.write(data as Buffer);
      return;
    }
    if (state === "checking") {
      if (binary) early.push(Buffer.from(data as Buffer));
      return;
    }
    state = "checking";
    clearTimeout(timer);
    let token = "";
    try {
      token = binary ? "" : ((JSON.parse(data.toString()) as { token?: string }).token ?? "");
    } catch {
      /* not a hello */
    }
    void (async () => {
      const auth = token ? await verifyUser(token, opts, runner.thread.id) : null;
      if (!auth?.ok || auth.claims.scope !== "client" || auth.claims.threadId !== runner.thread.id) return ws.close(4401, "unauthorized");
      if (!runner.previews.some(p => p.port === port)) return ws.close(4404, "not a preview port");
      open();
    })();
  });
  ws.on("close", () => {
    clearTimeout(timer);
    socket?.destroy();
  });
}
