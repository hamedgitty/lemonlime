import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, RunnerCapabilities, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";
import { cleanName, MAX_IMAGE_BYTES } from "../src/attachments.ts";
import { runnerHttpBase, uploadAttachment } from "@lemonlime/client";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-attach-"));
  const prompts: string[] = [];
  const adapter: AgentAdapter = {
    kind: "codex",
    createSession: () => ({ runTurn: async ctx => void prompts.push(ctx.prompt), saveState: () => ({}), dispose: async () => {} }),
  };
  const now = new Date().toISOString();
  const thread: Thread = {
    id: "attach-thread-1",
    title: "",
    agent: { kind: "codex", model: "gpt-6-astra", reasoning: "high" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread("attach-thread-1"),
    mode: "local",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const runner = new ThreadRunner({ thread, workdir: dir, dataDir: null, adapter, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => runner.close(),
    () => server.close(),
  );
  const base = `http://127.0.0.1:${server.port}`;
  const token = await signToken({ threadId: thread.id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  return { dir, runner, prompts, base, call };
}

describe("attachments", () => {
  it("upload in pieces, resume after a gap, and reach the agent with the message", async () => {
    const { dir, runner, prompts, call } = await boot();
    const content = Buffer.from("x".repeat(5000) + "end");
    expect(
      (await call("/attachments", { method: "POST", body: JSON.stringify({ id: "upload-0001", name: "../../notes.txt", size: content.length }) })).status,
    ).toBe(200);
    expect((await call("/attachments/upload-0001?offset=0", { method: "PUT", body: content.subarray(0, 3000) })).status).toBe(200);
    // A piece at the wrong place says where to carry on.
    const wrong = await call("/attachments/upload-0001?offset=0", { method: "PUT", body: content.subarray(3000) });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ received: 3000 });
    expect(await (await call("/attachments/upload-0001")).json()).toMatchObject({ received: 3000, done: false });
    const last = await (await call("/attachments/upload-0001?offset=3000", { method: "PUT", body: content.subarray(3000) })).json();
    expect(last).toMatchObject({ done: true, path: ".lemonlime-attachments/upload-0001/notes.txt" });
    expect(readFileSync(join(dir, last.path)).equals(content)).toBe(true);

    runner.sendMessage("summarise this", "m1", ["upload-0001"]);
    await runner.settled();
    expect(prompts[0]).toContain("summarise this");
    expect(prompts[0]).toContain(".lemonlime-attachments/upload-0001/notes.txt");
    expect(runner.store.since(0).find(e => e.type === "user_message")).toMatchObject({
      text: "summarise this",
      attachments: [{ id: "upload-0001", name: "notes.txt" }],
    });
    expect(() => runner.sendMessage("again", "m2", ["never-uploaded"])).toThrow(/haven't finished uploading/);
  });

  it("refuses big images, missing tokens, and says what the agent can do", async () => {
    const { base, call } = await boot();
    expect(
      (await call("/attachments", { method: "POST", body: JSON.stringify({ id: "upload-0002", name: "photo.png", size: MAX_IMAGE_BYTES + 1 }) })).status,
    ).toBe(413);
    expect((await fetch(`${base}/attachments/upload-0002`)).status).toBe(401);
    expect((await fetch(`${base}/attachments`, { method: "OPTIONS" })).headers.get("access-control-allow-origin")).toBe("*");
    const caps = RunnerCapabilities.parse(await (await fetch(`${base}/capabilities`)).json());
    expect(caps).toMatchObject({ agent: "codex", model: "gpt-6-astra", reasoningLevel: "high", attachments: { images: true, chunkBytes: 4 * 1024 * 1024 } });
    expect(caps.models.length).toBeGreaterThan(0);
    expect(cleanName("..\\\\evil/..hidden.sh")).toBe("hidden.sh");
  });

  it("the apps' uploader sends a file in pieces and gets past a dropped one", async () => {
    const { dir, base } = await boot();
    const token = () => signToken({ threadId: "attach-thread-1", scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
    const file = Object.assign(new Blob([bytes]), { name: "data.bin" });
    let drops = 1;
    const flaky: typeof fetch = async (url, init) => {
      if (init?.method === "PUT" && String(url).includes("offset=4096") && drops-- > 0) throw new TypeError("network down");
      return fetch(url, init);
    };
    const progress: number[] = [];
    const id = await uploadAttachment({ base, token, file, id: "upload-0003", chunkBytes: 4096, fetchImpl: flaky, onProgress: s => progress.push(s) });
    expect(id).toBe("upload-0003");
    expect(progress.at(-1)).toBe(10_000);
    expect(new Uint8Array(readFileSync(join(dir, ".lemonlime-attachments/upload-0003/data.bin"))).every((b, i) => b === i % 251)).toBe(true);
    expect(runnerHttpBase("wss://host.example/sandbox/lemonlime-abc123/ws")).toBe("https://host.example/sandbox/lemonlime-abc123");
  });
});
