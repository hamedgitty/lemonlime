import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitSubject, EventStore, GitWorkspace } from "../src/index.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir }).toString().trim();

describe("GitWorkspace", () => {
  it("branches from base, reports changes and commits them", async () => {
    const dir = tempDir();
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");

    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    await ws.ensureBranch("agent/abc123", "main");
    expect(await ws.currentBranch()).toBe("agent/abc123");

    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    const changes = await ws.collectChanges();
    expect(changes.map(c => [c.path, c.change]).sort()).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "added"],
    ]);
    expect(changes.find(c => c.path === "a.txt")!.diff).toContain("+two");

    const sha = await ws.commit("Update files");
    expect(sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(dir, "log", "-1", "--format=%an|%s")).toBe("LemonLime Agent|Update files");
    // main is untouched
    expect(git(dir, "show", "main:a.txt")).toBe("one");
    expect(await ws.commit("nothing")).toBeNull();
  });

  it("works in a brand-new repository and keeps runner data out of git", async () => {
    const dir = tempDir();
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    ws.excludePath(".lemonlime");
    await ws.ensureBranch("agent/new000", "main");
    writeFileSync(join(dir, "hello.md"), "# hi\n");
    const changes = await ws.collectChanges();
    expect(changes).toEqual([expect.objectContaining({ path: "hello.md", change: "added" })]);
    await ws.commit("First");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/new000");
  });

  it("re-uses an existing thread branch instead of recreating it", async () => {
    const dir = tempDir();
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "x");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "checkout", "-q", "-b", "agent/keep01");
    writeFileSync(join(dir, "kept.txt"), "work");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "earlier work");
    git(dir, "checkout", "-q", "main");

    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/keep01", "main");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("earlier work");
  });

  it("makes short commit subjects", () => {
    expect(commitSubject("Fix the login bug\nmore details")).toBe("Fix the login bug");
    expect(commitSubject("x".repeat(100))).toHaveLength(72);
    expect(commitSubject("   ")).toBe("Agent changes");
  });
});

describe("EventStore", () => {
  it("assigns increasing seqs, persists, and resumes", () => {
    const dir = tempDir();
    const file = join(dir, "events.jsonl");
    const store = new EventStore("abc123", file);
    const seen: number[] = [];
    store.subscribe(e => seen.push(e.seq));
    store.append({ type: "user_message", text: "a" });
    store.append({ type: "agent_message", text: "b" });
    store.append({ type: "status_change", from: "running", to: "idle" });
    expect(seen).toEqual([1, 2, 3]);
    expect(store.since(1).map(e => e.seq)).toEqual([2, 3]);

    const reopened = new EventStore("abc123", file);
    expect(reopened.latestSeq).toBe(3);
    expect(reopened.append({ type: "user_message", text: "c" }).seq).toBe(4);
  });

  it("survives a torn last line", () => {
    const dir = tempDir();
    const file = join(dir, "events.jsonl");
    const store = new EventStore("abc123", file);
    store.append({ type: "user_message", text: "ok" });
    writeFileSync(file, `${JSON.stringify(store.since(0)[0])}\n{"threadId":"abc123","seq":2,"at`, { flag: "w" });
    expect(new EventStore("abc123", file).latestSeq).toBe(1);
  });
});
