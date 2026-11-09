import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { branchForThread, signToken, type Thread, deriveAgentKey } from "@lemonlime/protocol";
import { allowedRequest, startServer, startTunnel, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const listen = (s: Server) => new Promise<number>(r => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

/** A dev server with a page, a WebSocket echo and server-sent events. */
async function devServer() {
  const http = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: tick 1\n\n");
      setTimeout(() => res.end("data: tick 2\n\n"), 30);
      return;
    }
    res.end(`<h1>hello from the sandbox</h1> host=${req.headers.host}`);
  });
  new WebSocketServer({ server: http }).on("connection", ws => ws.on("message", m => ws.send(`echo ${m}`)));
  const port = await listen(http);
  cleanups.push(() => new Promise(r => http.close(r)));
  return port;
}

async function boot() {
  const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
  const now = new Date().toISOString();
  const thread: Thread = {
    id: "preview-thread-1",
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread("preview-thread-1"),
    mode: "cloud",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  const sign = async (scope: "client" | "runner") =>
    signToken({ threadId: thread.id, scope, exp: Math.floor(Date.now() / 1000) + 60 }, scope === "runner" ? await deriveAgentKey(SECRET) : SECRET);
  return { runner, port: server.port, sign };
}

describe("previews", () => {
  it("offers a port the runner found listening, and only those", async () => {
    const { runner } = await boot();
    runner.setListeningPorts([{ port: 5173, command: "node" }]);
    expect(runner.store.since(0).findLast(e => e.type === "listening_ports")).toMatchObject({ ports: [{ port: 5173, command: "node" }] });
    expect(runner.offerListeningPort(3000)).toBe(false);
    expect(runner.offerListeningPort(5173)).toBe(true);
    expect(runner.previews).toMatchObject([{ port: 5173, name: "node" }]);
    // A script's preview address is offered once, and never the runner's own port.
    runner.offerScriptPreview("http://localhost:8080/app", "Dev", [7420]);
    runner.offerScriptPreview("http://localhost:7420/", "Oops", [7420]);
    expect(runner.previews.map(p => p.port)).toEqual([5173, 8080]);
  });

  it("carry HTTP, WebSockets and server-sent events from a sandbox port to 127.0.0.1", async () => {
    const dev = await devServer();
    const { runner, port, sign } = await boot();
    // The agent offers the port (what `lemonlime-runner preview` does).
    const offer = await fetch(`http://127.0.0.1:${port}/previews`, {
      method: "POST",
      headers: { authorization: `Bearer ${await sign("runner")}` },
      body: JSON.stringify({ port: dev, name: "web app" }),
    });
    expect(offer.status).toBe(200);
    expect(runner.store.since(0).at(-1)).toMatchObject({ type: "preview_update", previews: [{ port: dev, name: "web app" }] });

    const token = await sign("client");
    const tunnel = await startTunnel({ runnerUrl: `ws://127.0.0.1:${port}/ws`, port: dev, token: () => token });
    cleanups.push(() => tunnel.close());
    const page = await fetch(`http://127.0.0.1:${tunnel.port}/`);
    expect(await page.text()).toContain("hello from the sandbox");

    const ws = new WebSocket(`ws://127.0.0.1:${tunnel.port}/`);
    cleanups.push(() => ws.close());
    const echoed = await new Promise<string>(resolve => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", m => resolve(String(m)));
    });
    expect(echoed).toBe("echo ping");

    const sse = await (await fetch(`http://localhost:${tunnel.port}/events`)).text();
    expect(sse).toContain("tick 1");
    expect(sse).toContain("tick 2");
  });

  it("refuse other sites, unoffered ports and agents without the thread's secret", async () => {
    const dev = await devServer();
    const { port, sign } = await boot();
    expect((await fetch(`http://127.0.0.1:${port}/previews`, { method: "POST", body: JSON.stringify({ port: dev }) })).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/previews`, {
          method: "POST",
          headers: { authorization: `Bearer ${await sign("client")}` },
          body: JSON.stringify({ port: dev }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/previews`, {
          method: "POST",
          headers: { authorization: `Bearer ${await sign("runner")}` },
          body: JSON.stringify({ port }),
        })
      ).status,
    ).toBe(400); // its own port

    // Not offered: the runner closes the tunnel.
    const token = await sign("client");
    const tunnel = await startTunnel({ runnerUrl: `ws://127.0.0.1:${port}/ws`, port: dev, token: () => token });
    cleanups.push(() => tunnel.close());
    const raw = (head: string) =>
      new Promise<string>(resolve => {
        const s = connect(tunnel.port, "127.0.0.1", () => s.write(head));
        let out = "";
        s.on("data", d => (out += d));
        s.on("close", () => resolve(out));
        s.on("end", () => s.end());
      });
    expect(await raw(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${tunnel.port}\r\n\r\n`)).not.toContain("hello from the sandbox");

    // A rebinding page sends its own Host; a cross-site page sends its Origin.
    expect(await raw("GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n")).toContain("403");
    expect(allowedRequest(`GET / HTTP/1.1\r\nHost: localhost:${tunnel.port}\r\nOrigin: https://evil.example\r\n\r\n`, tunnel.port)).toMatchObject({
      ok: false,
    });
    expect(allowedRequest(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${tunnel.port}\r\nOrigin: http://127.0.0.1:${tunnel.port}\r\n\r\n`, tunnel.port)).toEqual({
      ok: true,
    });
  });
});
