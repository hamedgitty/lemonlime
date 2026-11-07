import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    await ws.excludePath(".lemonlime");
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

  describe("worktrees", () => {
    function userRepo(): string {
      const dir = tempDir();
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "a.txt"), "one\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "init");
      return dir;
    }

    it("works in its own folder and never touches the user's checkout", async () => {
      const repo = userRepo();
      // The user is mid-way through something on main.
      writeFileSync(join(repo, "a.txt"), "user edit\n");
      writeFileSync(join(repo, "scratch.txt"), "untracked\n");

      const wt = join(tempDir(), "wt", "thread-1");
      const ws = new GitWorkspace(wt);
      await ws.ensureWorktree(repo, "agent/thread-1", "main");
      expect(await ws.currentBranch()).toBe("agent/thread-1");
      expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("one\n");
      await ws.excludePath(".lemonlime");

      writeFileSync(join(wt, "a.txt"), "agent edit\n");
      await ws.collectChanges();
      await ws.commit("Agent change");

      // The user's checkout: same branch, same uncommitted work, main unchanged.
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("user edit\n");
      expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("untracked\n");
      expect(git(repo, "show", "main:a.txt")).toBe("one");
      // The agent's commit is visible from the user's repo on the thread branch.
      expect(git(repo, "show", "agent/thread-1:a.txt")).toBe("agent edit");
      expect(git(repo, "status", "--porcelain")).toContain("scratch.txt");

      // Starting again reuses the same worktree.
      await new GitWorkspace(wt).ensureWorktree(repo, "agent/thread-1", "main");
      expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("agent edit\n");

      // Removing it keeps the branch and its commits.
      await ws.removeWorktree(repo);
      expect(existsSync(wt)).toBe(false);
      expect(git(repo, "show", "agent/thread-1:a.txt")).toBe("agent edit");
      // ...and a new worktree for the same thread picks the branch up again.
      await new GitWorkspace(wt).ensureWorktree(repo, "agent/thread-1", "main");
      expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("agent edit\n");
    });

    it("explains when the thread branch is checked out in the user's folder", async () => {
      const repo = userRepo();
      git(repo, "checkout", "-q", "-b", "agent/thread-2");
      const ws = new GitWorkspace(join(tempDir(), "thread-2"));
      await expect(ws.ensureWorktree(repo, "agent/thread-2", "main")).rejects.toThrow(/checked out in another folder/);
    });

    it("refuses repositories without commits, folders that aren't repos, and foreign folders", async () => {
      const empty = tempDir();
      git(empty, "init", "-q");
      await expect(new GitWorkspace(join(tempDir(), "t")).ensureWorktree(empty, "agent/t", "main")).rejects.toThrow(/no commits yet/);
      await expect(new GitWorkspace(join(tempDir(), "t")).ensureWorktree(tempDir(), "agent/t", "main")).rejects.toThrow(/not a git repository/);

      const occupied = tempDir();
      writeFileSync(join(occupied, "x"), "x");
      await expect(new GitWorkspace(occupied).ensureWorktree(userRepo(), "agent/t", "main")).rejects.toThrow(/not empty/);

      const other = userRepo();
      const wt = join(tempDir(), "t");
      await new GitWorkspace(wt).ensureWorktree(other, "agent/t", "main");
      await expect(new GitWorkspace(wt).ensureWorktree(userRepo(), "agent/t", "main")).rejects.toThrow(/different repository/);
    });
  });
});

describe("runner cleanup command", () => {
  it("removes a thread's worktree and history but keeps its branch", async () => {
    const { cleanup, lemonlimeHome, worktreePathFor } = await import("../src/index.ts");
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const home = tempDir();
    const prev = process.env.LEMONLIME_HOME;
    process.env.LEMONLIME_HOME = home;
    try {
      const wt = worktreePathFor(lemonlimeHome(), repo, "clean-me-1");
      expect(wt.startsWith(join(home, "worktrees"))).toBe(true);
      await new GitWorkspace(wt).ensureWorktree(repo, "agent/clean-me-1", "main");
      const history = join(home, "threads", "clean-me-1");
      execFileSync("mkdir", ["-p", history]);
      writeFileSync(join(history, "events.jsonl"), "");
      const write = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try {
        await cleanup(["--thread", "clean-me-1", "--source-repo", repo]);
      } finally {
        process.stdout.write = write;
      }
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(history)).toBe(false);
      expect(git(repo, "branch", "--list", "agent/clean-me-1")).toContain("agent/clean-me-1");
      expect(git(repo, "worktree", "list")).not.toContain("clean-me-1");
    } finally {
      if (prev === undefined) delete process.env.LEMONLIME_HOME;
      else process.env.LEMONLIME_HOME = prev;
    }
  });
});
