import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxProvider,
  DaytonaProvider,
  DockerProvider,
  E2BProvider,
  mapDaytonaState,
  mapDockerState,
  mapE2BState,
  runnerWsUrl,
  type RunnerLaunch,
} from "../src/index.ts";
import { envelope } from "../src/e2b.ts";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | (() => Response);

/** A fetch that answers from a script and records every request. Never touches the network. */
function scriptedFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof Uint8Array) body = decodeEnvelope(init.body);
    calls.push({ method: init?.method ?? "GET", url, headers, body });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${init?.method} ${url}`);
    return typeof next === "function" ? next() : next;
  });
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const empty = (status = 200) => new Response(null, { status });

function decodeEnvelope(bytes: Uint8Array): unknown {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, false);
  return { flags: bytes[0], message: JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + len))) };
}

/** A Connect streaming response that sends `frames` and then stays open, like a live process. */
function connectStream(frames: Array<{ flags?: number; message: unknown }>, onCancel?: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        const e = envelope(f.message);
        e[0] = f.flags ?? 0;
        controller.enqueue(e);
      }
    },
    cancel: onCancel,
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/connect+json" } });
}

const runner: RunnerLaunch = { command: "lemonlime-runner --thread t1 --port 7420", port: 7420, env: { LEMONLIME_THREAD_SECRET: "s" } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSandboxProvider", () => {
  it("builds each provider from an explicit env", () => {
    expect(createSandboxProvider({}).name).toBe("docker");
    expect(createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "Docker" })).toBeInstanceOf(DockerProvider);
    expect(createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "daytona", DAYTONA_API_KEY: "k" })).toBeInstanceOf(DaytonaProvider);
    expect(createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "k" })).toBeInstanceOf(E2BProvider);
  });

  it("names the missing variable", () => {
    expect(() => createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "daytona" })).toThrow("DAYTONA_API_KEY is required for the daytona sandbox provider");
    expect(() => createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "e2b" })).toThrow("E2B_API_KEY is required for the e2b sandbox provider");
    expect(() => createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "nope" })).toThrow('Unknown sandbox provider "nope". Use docker, daytona or e2b.');
  });

  it("makes no requests while constructing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "daytona", DAYTONA_API_KEY: "k" });
    createSandboxProvider({ LEMONLIME_SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "k" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("state mapping", () => {
  it("maps Daytona states", () => {
    expect(mapDaytonaState("STARTED")).toBe("running");
    expect(mapDaytonaState("pending_build")).toBe("starting");
    expect(mapDaytonaState("resuming")).toBe("starting");
    expect(mapDaytonaState("stopped")).toBe("paused");
    expect(mapDaytonaState("archived")).toBe("paused");
    expect(mapDaytonaState("destroyed")).toBe("stopped");
    expect(mapDaytonaState("build_failed")).toBe("error");
    expect(mapDaytonaState("weird")).toBe("unknown");
  });

  it("maps E2B and Docker states", () => {
    expect(mapE2BState("running")).toBe("running");
    expect(mapE2BState("paused")).toBe("paused");
    expect(mapE2BState("other")).toBe("unknown");
    expect(mapDockerState("exited")).toBe("paused");
    expect(mapDockerState("running")).toBe("running");
  });

  it("builds runner WebSocket URLs", () => {
    expect(runnerWsUrl("https://7420-abc.e2b.app")).toBe("wss://7420-abc.e2b.app/ws");
    expect(runnerWsUrl("http://127.0.0.1:5555/")).toBe("ws://127.0.0.1:5555/ws");
  });
});

describe("DaytonaProvider", () => {
  const API = "https://app.daytona.io/api";
  const auth = { authorization: "Bearer dk" };
  const make = (fetch: ReturnType<typeof scriptedFetch>["fetch"], extra: Partial<ConstructorParameters<typeof DaytonaProvider>[0]> = {}) =>
    new DaytonaProvider({ apiKey: "dk", image: "lemonlime/sandbox:latest", pollIntervalMs: 1, fetch, ...extra });

  it("creates from an image, waits for start, starts the runner and returns the preview URL", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ id: "sb1", state: "creating", toolboxProxyUrl: "https://proxy.example/toolbox" }),
      json({ id: "sb1", state: "starting", toolboxProxyUrl: "https://proxy.example/toolbox" }),
      json({ id: "sb1", state: "started", toolboxProxyUrl: "https://proxy.example/toolbox" }),
      json({ sessionId: "lemonlime-runner" }),
      json({ cmdId: "c1" }),
      json({ sandboxId: "sb1", url: "https://7420-sb1.proxy.example", token: "t" }),
    ]);
    const info = await make(fetch).create({ threadId: "t1", size: "large", runner, labels: { "lemonlime.runner-port": "7420" } });

    expect(info).toEqual({ id: "sb1", provider: "daytona", state: "running", runnerUrl: "https://7420-sb1.proxy.example" });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/sandbox`,
      `GET ${API}/sandbox/sb1`,
      `GET ${API}/sandbox/sb1`,
      "POST https://proxy.example/toolbox/sb1/process/session",
      "POST https://proxy.example/toolbox/sb1/process/session/lemonlime-runner/exec",
      `GET ${API}/sandbox/sb1/ports/7420/preview-url`,
    ]);
    for (const c of calls) expect(c.headers).toMatchObject(auth);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({
      buildInfo: { dockerfileContent: "FROM lemonlime/sandbox:latest\n" },
      cpu: 2,
      memory: 4,
      disk: 10,
      env: { LEMONLIME_THREAD_SECRET: "s" },
      labels: { "lemonlime.thread": "t1", "lemonlime.runner-port": "7420" },
      public: true,
      autoStopInterval: 60,
      autoArchiveInterval: 1440,
    });
    expect(calls[3]!.body).toEqual({ sessionId: "lemonlime-runner" });
    expect(calls[4]!.body).toEqual({ command: runner.command, runAsync: true });
  });

  it("uses the snapshot for the thread's size, falling back to the shared one", async () => {
    const started = () => [
      json({ id: "sb9", state: "started", toolboxProxyUrl: "https://proxy.example/toolbox" }),
      json({ cmdId: "c1" }),
      json({ cmdId: "c2" }),
      json({ sandboxId: "sb9", url: "https://preview.example", token: "t" }),
    ];
    const opts = { snapshot: "shared-snap", snapshots: { large: "large-snap" } };
    const large = scriptedFetch(started());
    await make(large.fetch, opts).create({ threadId: "t9", size: "large", runner });
    expect((large.calls[0]!.body as { snapshot?: string }).snapshot).toBe("large-snap");
    const small = scriptedFetch(started());
    await make(small.fetch, opts).create({ threadId: "t9", size: "small", runner });
    expect((small.calls[0]!.body as { snapshot?: string }).snapshot).toBe("shared-snap");
  });

  it("creates from a snapshot without resources and looks up the toolbox URL when missing", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ id: "sb2", state: "started" }),
      json({ url: "https://proxy.example/toolbox/" }),
      json({ statusCode: 409, message: "session already exists" }, 409),
      json({ cmdId: "c1" }),
      json({ sandboxId: "sb2", url: "https://preview.example", token: "t" }),
    ]);
    const info = await make(fetch, { snapshot: "lemonlime-snap", apiUrl: "https://daytona.example/api/" }).create({ threadId: "t2", size: "small", runner });

    expect(info.runnerUrl).toBe("https://preview.example");
    expect(calls[0]!.url).toBe("https://daytona.example/api/sandbox");
    expect(calls[0]!.body).toEqual({
      snapshot: "lemonlime-snap",
      env: { LEMONLIME_THREAD_SECRET: "s" },
      labels: { "lemonlime.thread": "t2" },
      public: true,
      autoStopInterval: 60,
      autoArchiveInterval: 1440,
    });
    expect(calls[1]!.url).toBe("https://daytona.example/api/sandbox/sb2/toolbox-proxy-url");
    expect(calls[3]!.url).toBe("https://proxy.example/toolbox/sb2/process/session/lemonlime-runner/exec");
  });

  it("times out polling and deletes the half-made sandbox", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (init?.method === "POST") return json({ id: "sb3", state: "creating" });
      if (init?.method === "DELETE") return json({ id: "sb3", state: "destroying" });
      return json({ id: "sb3", state: "pulling_snapshot" });
    });
    const provider = make(fetch, { startTimeoutMs: 1500, pollIntervalMs: 500 });
    await expect(provider.create({ threadId: "t3", size: "small", runner })).rejects.toThrow(
      "Daytona sandbox sb3 did not start within 2s (last state pulling_snapshot)",
    );
    expect(calls[0]).toBe(`POST ${API}/sandbox`);
    expect(calls.filter(c => c.startsWith("GET")).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe(`DELETE ${API}/sandbox/sb3`);
  });

  it("reports a failed build with its reason", async () => {
    const { fetch } = scriptedFetch([
      json({ id: "sb4", state: "pending_build" }),
      json({ id: "sb4", state: "build_failed", errorReason: "image not found" }),
      empty(),
    ]);
    await expect(make(fetch).create({ threadId: "t4", size: "small", runner })).rejects.toThrow(
      "Daytona sandbox sb4 failed to start (state build_failed: image not found)",
    );
  });

  it("gets a sandbox, using the runner-port label for the URL", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ id: "sb1", state: "started", labels: { "lemonlime.runner-port": "7420" } }),
      json({ sandboxId: "sb1", url: "https://preview.example", token: "t" }),
      json({ id: "sb1", state: "stopped", labels: {} }),
      json({ statusCode: 404, message: "Sandbox not found" }, 404),
    ]);
    const p = make(fetch);
    expect(await p.get("sb1")).toEqual({ id: "sb1", provider: "daytona", state: "running", runnerUrl: "https://preview.example" });
    expect(await p.get("sb1")).toEqual({ id: "sb1", provider: "daytona", state: "paused", runnerUrl: null });
    expect(await p.get("gone")).toBeNull();
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/sandbox/sb1`,
      `GET ${API}/sandbox/sb1/ports/7420/preview-url`,
      `GET ${API}/sandbox/sb1`,
      `GET ${API}/sandbox/gone`,
    ]);
  });

  it("pauses by stopping and waiting, and ignores missing or stopped sandboxes", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ id: "sb1", state: "started" }),
      json({ id: "sb1", state: "stopping" }),
      json({ id: "sb1", state: "stopping" }),
      json({ id: "sb1", state: "stopped" }),
      json({ id: "sb1", state: "stopped" }),
      json({ message: "not found" }, 404),
    ]);
    const p = make(fetch);
    await p.pause("sb1");
    await p.pause("sb1");
    await p.pause("gone");
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/sandbox/sb1`,
      `POST ${API}/sandbox/sb1/stop`,
      `GET ${API}/sandbox/sb1`,
      `GET ${API}/sandbox/sb1`,
      `GET ${API}/sandbox/sb1`,
      `GET ${API}/sandbox/gone`,
    ]);
    expect(calls[1]!.body).toBeUndefined();
  });

  it("resumes by starting, waiting and restarting the runner", async () => {
    const tb = "https://proxy.example/toolbox";
    const { fetch, calls } = scriptedFetch([
      json({ id: "sb1", state: "stopped", toolboxProxyUrl: tb }),
      json({ id: "sb1", state: "starting", toolboxProxyUrl: tb }),
      json({ id: "sb1", state: "started", toolboxProxyUrl: tb }),
      json({}),
      json({ cmdId: "c2" }),
      json({ sandboxId: "sb1", url: "https://preview.example", token: "t" }),
    ]);
    const info = await make(fetch).resume("sb1", runner);
    expect(info).toEqual({ id: "sb1", provider: "daytona", state: "running", runnerUrl: "https://preview.example" });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/sandbox/sb1`,
      `POST ${API}/sandbox/sb1/start`,
      `GET ${API}/sandbox/sb1`,
      `POST ${tb}/sb1/process/session`,
      `POST ${tb}/sb1/process/session/lemonlime-runner/exec`,
      `GET ${API}/sandbox/sb1/ports/7420/preview-url`,
    ]);
  });

  it("destroys, ignoring a missing sandbox but not other errors", async () => {
    const { fetch, calls } = scriptedFetch([json({ id: "sb1", state: "destroying" }), json({ message: "not found" }, 404), json({ message: "boom" }, 500)]);
    const p = make(fetch);
    await p.destroy("sb1");
    await p.destroy("gone");
    await expect(p.destroy("sb9")).rejects.toThrow("Daytona DELETE /api/sandbox/sb9 failed with 500: boom");
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${API}/sandbox/sb1`, headers: auth });
  });

  it("uses the global fetch by default", async () => {
    const fetch = vi.fn(async () => json({ id: "sb1", state: "stopped" }));
    vi.stubGlobal("fetch", fetch);
    const p = new DaytonaProvider({ apiKey: "dk", image: "img" });
    expect((await p.get("sb1"))?.state).toBe("paused");
    expect(fetch).toHaveBeenCalledWith(`${API}/sandbox/sb1`, expect.objectContaining({ method: "GET" }));
  });
});

describe("E2BProvider", () => {
  const API = "https://api.e2b.app";
  const make = (fetch: ReturnType<typeof scriptedFetch>["fetch"]) =>
    new E2BProvider({ apiKey: "ek", templates: { small: "tpl-small", large: "tpl-large" }, fetch });

  it("creates a sandbox and starts the runner through envd, leaving it running", async () => {
    let cancelled = false;
    const { fetch, calls } = scriptedFetch([
      json({ sandboxID: "ib1", clientID: "c", templateID: "tpl-small", envdVersion: "0.5.4", envdAccessToken: "envd-tok", domain: null }, 201),
      () => connectStream([{ message: { event: { start: { pid: 42 } } } }], () => (cancelled = true)),
    ]);
    const info = await make(fetch).create({ threadId: "t1", size: "small", runner, labels: { "lemonlime.workspace": "w" } });

    expect(info).toEqual({ id: "ib1", provider: "e2b", state: "running", runnerUrl: "https://7420-ib1.e2b.app" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}/v2/sandboxes` });
    expect(calls[0]!.headers).toMatchObject({ "x-api-key": "ek", "content-type": "application/json" });
    expect(calls[0]!.body).toEqual({
      templateID: "tpl-small",
      metadata: { "lemonlime.thread": "t1", "lemonlime.runner-port": "7420", "lemonlime.workspace": "w" },
      envVars: { LEMONLIME_THREAD_SECRET: "s" },
      timeout: 3600,
      secure: true,
    });

    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe("https://49983-ib1.e2b.app/process.Process/Start");
    expect(calls[1]!.headers).toEqual({
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      "connect-timeout-ms": "60000",
      "keepalive-ping-interval": "50",
      "e2b-sandbox-id": "ib1",
      "e2b-sandbox-port": "49983",
      "x-access-token": "envd-tok",
    });
    expect(calls[1]!.body).toEqual({
      flags: 0,
      message: {
        process: { cmd: "/bin/bash", args: ["-l", "-c", runner.command], envs: { LEMONLIME_THREAD_SECRET: "s" } },
        stdin: false,
      },
    });
    // We disconnect from the event stream once the process has started.
    expect(cancelled).toBe(true);
  });

  it("names the default user for old envd versions and skips keepalives", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ sandboxID: "ib2", envdAccessToken: "envd-tok", envdVersion: "0.3.1", domain: "e2b.example" }, 201),
      () => connectStream([{ message: { event: { keepalive: {} } } }, { message: { event: { start: { pid: 7 } } } }]),
    ]);
    const info = await make(fetch).create({ threadId: "t2", size: "large", runner });
    expect(info.runnerUrl).toBe("https://7420-ib2.e2b.example");
    expect(calls[0]!.body).toMatchObject({ templateID: "tpl-large" });
    expect(calls[1]!.url).toBe("https://49983-ib2.e2b.example/process.Process/Start");
    expect(calls[1]!.headers.authorization).toBe(`Basic ${btoa("user:")}`);
    expect(calls[1]!.headers["x-access-token"]).toBe("envd-tok");
  });

  it("kills the sandbox when envd refuses to start the runner", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ sandboxID: "ib3", envdAccessToken: "envd-tok", envdVersion: "0.5.0" }, 201),
      () => connectStream([{ flags: 2, message: { error: { code: "invalid_argument", message: "bad cmd" } } }]),
      empty(204),
    ]);
    await expect(make(fetch).create({ threadId: "t3", size: "small", runner })).rejects.toThrow("E2B could not start the runner: invalid_argument: bad cmd");
    expect(calls[2]).toMatchObject({ method: "DELETE", url: `${API}/sandboxes/ib3` });
  });

  it("won't start the runner in a sandbox E2B didn't lock down, and removes it", async () => {
    const { fetch, calls } = scriptedFetch([json({ sandboxID: "ib5", envdVersion: "0.5.0" }, 201), empty(204)]);
    await expect(make(fetch).create({ threadId: "t5", size: "small", runner })).rejects.toThrow(/access token/);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: `${API}/sandboxes/ib5` });
  });

  it("reports an envd HTTP error", async () => {
    const { fetch } = scriptedFetch([
      json({ sandboxID: "ib4", envdAccessToken: "envd-tok", envdVersion: "0.5.0" }, 201),
      new Response("sandbox not reachable", { status: 502 }),
      empty(204),
    ]);
    await expect(make(fetch).create({ threadId: "t4", size: "small", runner })).rejects.toThrow(
      "E2B could not start the runner: envd answered 502: sandbox not reachable",
    );
  });

  it("gets a sandbox", async () => {
    const { fetch, calls } = scriptedFetch([
      json({ sandboxID: "ib1", state: "running", metadata: { "lemonlime.runner-port": "7421" }, domain: null }),
      json({ sandboxID: "ib1", state: "paused", metadata: {} }),
      json({ code: 404, message: "not found" }, 404),
    ]);
    const p = make(fetch);
    expect(await p.get("ib1")).toEqual({ id: "ib1", provider: "e2b", state: "running", runnerUrl: "https://7421-ib1.e2b.app" });
    expect(await p.get("ib1")).toEqual({ id: "ib1", provider: "e2b", state: "paused", runnerUrl: null });
    expect(await p.get("gone")).toBeNull();
    expect(calls[0]).toMatchObject({ method: "GET", url: `${API}/sandboxes/ib1`, headers: { "x-api-key": "ek" } });
  });

  it("pauses, treating already-paused and missing sandboxes as done", async () => {
    const { fetch, calls } = scriptedFetch([
      empty(204),
      json({ message: "already paused" }, 409),
      json({ message: "nope" }, 404),
      json({ message: "boom" }, 500),
    ]);
    const p = make(fetch);
    await p.pause("ib1");
    await p.pause("ib1");
    await p.pause("gone");
    await expect(p.pause("ib9")).rejects.toThrow("E2B POST /sandboxes/ib9/pause failed with 500: boom");
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}/sandboxes/ib1/pause`, body: {}, headers: { "x-api-key": "ek" } });
  });

  it("resumes by connecting, without restarting the runner", async () => {
    const { fetch, calls } = scriptedFetch([json({ sandboxID: "ib1", envdVersion: "0.5.0", domain: "e2b.app" }, 201)]);
    const info = await make(fetch).resume("ib1", runner);
    expect(info).toEqual({ id: "ib1", provider: "e2b", state: "running", runnerUrl: "https://7420-ib1.e2b.app" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}/v2/sandboxes/ib1/connect`, body: { timeout: 3600 } });
  });

  it("destroys, ignoring a missing sandbox", async () => {
    const { fetch, calls } = scriptedFetch([empty(204), json({ message: "not found" }, 404)]);
    const p = make(fetch);
    await p.destroy("ib1");
    await p.destroy("gone");
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([`DELETE ${API}/sandboxes/ib1`, `DELETE ${API}/sandboxes/gone`]);
  });
});
