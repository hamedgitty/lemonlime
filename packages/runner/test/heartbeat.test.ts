import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import { ActivityMonitor, startHeartbeat, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-hb-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe("ActivityMonitor", () => {
  function fakeProc() {
    const root = temp();
    mkdirSync(join(root, "net"), { recursive: true });
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const listen = (port: number, inode: number) =>
      `   0: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1\n`;
    const proc = (pid: number, comm: string, ticks: number) => {
      mkdirSync(join(root, String(pid)), { recursive: true });
      writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) S 1 1 1 0 -1 4194560 100 0 0 0 ${ticks} 0 0 0 20 0 1 0\n`);
    };
    const dev = (rx: number) => writeFileSync(join(root, "net", "dev"), `Inter-| Receive\n face |bytes\n    lo: 999999 0\n  eth0: ${rx} 0 0 0\n`);
    return { root, header, listen, proc, dev };
  }

  it("says nothing outside Linux", () => {
    expect(new ActivityMonitor({ procRoot: temp() }).sample()).toBeNull();
  });

  it("spots a dev server, but not the runner's own sockets", () => {
    const p = fakeProc();
    writeFileSync(join(p.root, "net", "tcp"), p.header + p.listen(7420, 111) + p.listen(43210, 222));
    writeFileSync(join(p.root, "net", "tcp6"), p.header);
    p.dev(0);
    mkdirSync(join(p.root, "4242", "fd"), { recursive: true });
    symlinkSync("socket:[222]", join(p.root, "4242", "fd", "7"));
    const ours = new ActivityMonitor({ procRoot: p.root, ownPid: 4242, ownPorts: [7420] });
    expect(ours.sample()).toBeNull();
    writeFileSync(join(p.root, "net", "tcp6"), p.header + p.listen(5173, 333));
    expect(ours.sample()).toBe("server");
  });

  it("spots builds and downloads, ignoring housekeeping", () => {
    const p = fakeProc();
    writeFileSync(join(p.root, "net", "tcp"), p.header);
    let now = 0;
    const m = new ActivityMonitor({ procRoot: p.root, ownPid: 1, now: () => now });
    p.proc(10, "node", 1000);
    p.proc(11, "gopls", 1000);
    p.dev(1000);
    expect(m.sample()).toBeNull(); // first sample: nothing to compare yet
    now = 10_000;
    p.proc(11, "gopls", 9000); // language server busy: upkeep, doesn't count
    expect(m.sample()).toBeNull();
    now = 20_000;
    p.proc(10, "node", 1500); // 500 ticks in 10 s = half a core
    expect(m.sample()).toBe("build");
    now = 30_000;
    p.dev(1000 + 5 * 1024 * 1024); // 5 MB in 10 s
    expect(m.sample()).toBe("download");
  });
});

describe("heartbeat", () => {
  function thread(id: string): Thread {
    const now = new Date().toISOString();
    return {
      id,
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread(id),
      mode: "cloud",
      status: "provisioning",
      sandboxSize: "small",
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** A pretend control plane that keeps history and an inbox like the real one. */
  async function fakeControlPlane(opts: { drain?: boolean; inbox?: { clientMsgId: string; text: string }[] }) {
    const stored: ThreadEvent[] = [];
    const heartbeats: Record<string, unknown>[] = [];
    const acked: string[] = [];
    let inbox = opts.inbox ?? [];
    let drain = opts.drain ?? false;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        const send = (v: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(v));
        };
        if (req.url === "/api/runner/history") {
          const events = JSON.parse(body).events as ThreadEvent[];
          for (const e of events) if (e.seq === stored.length + 1) stored.push(e);
          return send({ storedSeq: stored.length });
        }
        if (req.url === "/api/runner/heartbeat") {
          const hb = JSON.parse(body);
          heartbeats.push(hb);
          if (hb.drained) drain = false;
          return send({ action: drain ? "drain" : "none", pendingMessages: inbox.length });
        }
        if (req.url?.startsWith("/api/runner/inbox") && req.method === "GET") return send({ messages: inbox });
        if (req.url === "/api/runner/inbox") {
          const ids = JSON.parse(body).clientMsgIds as string[];
          acked.push(...ids);
          inbox = inbox.filter(m => !ids.includes(m.clientMsgId));
          return send({ ok: true });
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>(r => server.close(() => r())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stored, heartbeats, acked };
  }

  async function runner(id: string) {
    const dir = temp();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: dir });
    const prompts: string[] = [];
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async ctx => {
          prompts.push(ctx.prompt);
          ctx.emit({ type: "agent_message", text: `done: ${ctx.prompt}` });
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const r = new ThreadRunner({ thread: thread(id), workdir: dir, dataDir: null, adapter, session: { autonomy: "full" }, bundledSkills: false });
    await r.init();
    cleanups.push(() => r.close());
    return { r, prompts };
  }

  it("uploads history, drains on request, and says so", async () => {
    const cp = await fakeControlPlane({ drain: true });
    const { r } = await runner("hb-thread-1");
    r.sendMessage("hello", "m1");
    await r.settled();
    const hb = startHeartbeat(r, {
      controlPlaneUrl: cp.url,
      threadSecret: "secret-for-heartbeat-tests-0123",
      version: "t",
      onShutdown: () => undefined,
      intervalMs: 60_000,
      activity: { sample: () => null },
    });
    cleanups.push(() => hb.stop());
    await hb.beat();
    await hb.beat();
    expect(cp.stored.map(e => e.seq)).toEqual(r.store.since(0).map(e => e.seq));
    expect(cp.heartbeats.some(h => h.drained === true)).toBe(true);
  });

  it("queues messages sent while paused, once, and acknowledges them", async () => {
    const cp = await fakeControlPlane({ inbox: [{ clientMsgId: "p1", text: "while you were away" }] });
    const { r, prompts } = await runner("hb-thread-2");
    const hb = startHeartbeat(r, {
      controlPlaneUrl: cp.url,
      threadSecret: "secret-for-heartbeat-tests-0123",
      version: "t",
      onShutdown: () => undefined,
      intervalMs: 60_000,
      activity: { sample: () => "server" },
    });
    cleanups.push(() => hb.stop());
    await hb.beat();
    await r.settled();
    await hb.beat();
    expect(prompts).toEqual(["while you were away"]);
    expect(cp.acked).toEqual(["p1"]);
    expect(cp.heartbeats.some(h => h.background === "server")).toBe(true);
  });
});
