import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";
import { contentTypeFor, findWorkdirFile, relativeParts, resolveWorkdirFile } from "../src/files.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir: string, path: string, data: string | Buffer = "hello\n") {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), data);
}

/** A working folder with files, plus a secret next to it that must never be readable. */
function setup() {
  const outside = tempDir("lemonlime-outside-");
  write(outside, "secret.txt", "top secret");
  const dir = tempDir("lemonlime-files-");
  write(dir, "src/app.ts", "export const x = 1;\n");
  write(dir, "img/dot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  write(dir, "big.log", "x".repeat(2048));
  write(dir, ".git/config", "[remote] url = https://token@host/repo");
  write(dir, ".lemonlime/events.jsonl", "{}");
  symlinkSync(join(outside, "secret.txt"), join(dir, "escape.txt"));
  symlinkSync(outside, join(dir, "linked-dir"));
  symlinkSync(join(dir, "src/app.ts"), join(dir, "inside-link.ts"));
  symlinkSync(join(dir, ".git"), join(dir, "git-link"));
  return { dir, outside };
}

describe("reading a file from the working folder", () => {
  it("accepts only plain relative paths", () => {
    expect(relativeParts("src/app.ts")).toEqual(["src", "app.ts"]);
    expect(relativeParts("./src//app.ts")).toEqual(["src", "app.ts"]);
    for (const bad of ["", "/etc/passwd", "\\\\server\\share", "C:\\x", "c:/x", "../x", "src/../../x", "src/..", "a\0b", "x".repeat(5000)])
      expect(relativeParts(bad), bad).toBeNull();
  });

  it("reads files inside, and refuses escapes, symlinks out, .git and .lemonlime", async () => {
    const { dir, outside } = setup();
    const ok = await resolveWorkdirFile(dir, "src/app.ts", 1024);
    expect("data" in ok && ok.data.toString()).toBe("export const x = 1;\n");
    const link = await resolveWorkdirFile(dir, "inside-link.ts", 1024);
    expect("data" in link && link.data.toString()).toBe("export const x = 1;\n");

    const status = async (p: string) => {
      const r = await resolveWorkdirFile(dir, p, 1024);
      return "status" in r ? r.status : 200;
    };
    expect(await status("../" + outside.split("/").pop() + "/secret.txt")).toBe(400);
    expect(await status(join(outside, "secret.txt"))).toBe(400);
    expect(await status("escape.txt")).toBe(403);
    expect(await status("linked-dir/secret.txt")).toBe(403);
    expect(await status(".git/config")).toBe(403);
    expect(await status("src/.git/config")).toBe(403);
    expect(await status("git-link/config")).toBe(403);
    expect(await status(".lemonlime/events.jsonl")).toBe(403);
    expect(await status("src")).toBe(400);
    expect(await status("missing.txt")).toBe(404);
    expect(await status("big.log")).toBe(413);
  });

  it("names the content type", () => {
    expect(contentTypeFor("a/b.PNG")).toBe("image/png");
    expect(contentTypeFor("x.pdf")).toBe("application/pdf");
    expect(contentTypeFor("x.ts", Buffer.from("let a"))).toMatch(/^text\/plain/);
    expect(contentTypeFor("x.bin", Buffer.from([1, 0, 2]))).toBe("application/octet-stream");
  });

  it("serves GET /file with a client token only", async () => {
    const { dir } = setup();
    const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "file-thread-1",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread("file-thread-1"),
      mode: "local",
      status: "idle",
      sandboxSize: "small",
      latestSeq: 0,
      mine: true,
      shared: false,
      createdAt: now,
      updatedAt: now,
    };
    const runner = new ThreadRunner({ thread, workdir: dir, dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
    await runner.init();
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    cleanups.push(
      () => runner.close(),
      () => server.close(),
    );
    const exp = Math.floor(Date.now() / 1000) + 60;
    const client = await signToken({ threadId: thread.id, scope: "client", exp }, SECRET);
    const runnerToken = await signToken({ threadId: thread.id, scope: "runner", exp }, SECRET);
    const other = await signToken({ threadId: "another-thread", scope: "client", exp }, SECRET);
    const get = (path: string, token?: string) =>
      fetch(`http://127.0.0.1:${server.port}/file?path=${encodeURIComponent(path)}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

    const res = await get("src/app.ts", client);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("export const x = 1;\n");
    const png = await get("img/dot.png", client);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())[0]).toBe(0x89);

    expect((await get("src/app.ts")).status).toBe(401);
    expect((await get("src/app.ts", runnerToken)).status).toBe(401);
    expect((await get("src/app.ts", other)).status).toBe(401);
    expect((await get("../etc/passwd", client)).status).toBe(400);
    expect((await get("escape.txt", client)).status).toBe(403);
    expect((await get(".git/config", client)).status).toBe(403);
  });
});

describe("findWorkdirFile", () => {
  it("finds files the terminal printed, relative or absolute, only inside the folder", async () => {
    const outside = tempDir("lemonlime-outside-");
    write(outside, "secret.txt", "top secret");
    const dir = tempDir("lemonlime-files-");
    write(dir, "src/app.ts");
    write(dir, ".git/config");
    expect(await findWorkdirFile(dir, "src/app.ts")).toBe("src/app.ts");
    expect(await findWorkdirFile(dir, "./src//app.ts")).toBe("src/app.ts");
    expect(await findWorkdirFile(dir, join(dir, "src", "app.ts"))).toBe("src/app.ts");
    expect(await findWorkdirFile(dir, "src")).toBeNull();
    expect(await findWorkdirFile(dir, "src/missing.ts")).toBeNull();
    expect(await findWorkdirFile(dir, ".git/config")).toBeNull();
    expect(await findWorkdirFile(dir, join(outside, "secret.txt"))).toBeNull();
    expect(await findWorkdirFile(dir, "../secret.txt")).toBeNull();
  });
});
