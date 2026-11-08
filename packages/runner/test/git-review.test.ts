import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareUrlFor, githubRepoWebUrl } from "@lemonlime/protocol";
import { GitReview, GitWorkspace, type GhRunner } from "../src/index.ts";
import { countPorcelain, parseGhPullRequest, parseHunks, parseNameStatus, parseNumstat, rollupChecks, splitPatch } from "../src/git-review.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-review-"));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
    .toString()
    .trim();

const noGh: GhRunner = () => Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));

/** main with a.txt and old.txt; the thread branch renames, edits, adds a binary, then leaves uncommitted work. */
async function setup(caps?: ConstructorParameters<typeof GitReview>[1]["caps"]) {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  writeFileSync(join(dir, "old name.txt"), "a file that will be renamed\nwith a few lines\nso git sees the rename\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const ws = new GitWorkspace(dir);
  await ws.ensureBranch("agent/review1", "main");

  git(dir, "mv", "old name.txt", "new name.txt");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 10]));
  unlinkSync(join(dir, "gone.txt"));
  await ws.collectChanges();
  await ws.commit("First turn");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
  await ws.collectChanges();
  await ws.commit("Second turn");

  // Uncommitted: an edit and an untracked file.
  writeFileSync(join(dir, "a.txt"), "zero\none\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
  writeFileSync(join(dir, "draft.md"), "# notes\n");
  const review = new GitReview(ws, {
    branch: "agent/review1",
    baseBranch: "main",
    threadId: "review1",
    title: () => "Review",
    gh: noGh,
    ...(caps ? { caps } : {}),
  });
  return { dir, ws, review };
}

describe("GitReview diffs", () => {
  it("shows the whole branch against the merge base, with statuses, counts, renames and binaries", async () => {
    const { dir, review } = await setup();
    const indexBefore = git(dir, "diff", "--cached", "--name-only");
    const d = await review.diff({ scope: "branch" });
    expect(d.commits.map(c => c.subject)).toEqual(["Second turn", "First turn"]);
    const byPath = Object.fromEntries(d.files.map(f => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["a.txt", "draft.md", "gone.txt", "logo.bin", "new name.txt"]);
    expect(byPath["new name.txt"]).toMatchObject({ status: "renamed", oldPath: "old name.txt", additions: 0, deletions: 0 });
    expect(byPath["logo.bin"]).toMatchObject({ status: "added", binary: true, hunks: [] });
    expect(byPath["gone.txt"]).toMatchObject({ status: "deleted", deletions: 1 });
    expect(byPath["draft.md"]).toMatchObject({ status: "added", additions: 1 });
    expect(byPath["a.txt"]).toMatchObject({ status: "modified", additions: 3, deletions: 2 });
    expect(byPath["a.txt"]!.hunks[0]!.lines).toContain("+THREE");
    // The real index is left as it was (untracked files stay untracked).
    expect(git(dir, "diff", "--cached", "--name-only")).toBe(indexBefore);
    expect(git(dir, "status", "--porcelain")).toContain("?? draft.md");
  });

  it("shows only uncommitted work, and one commit at a time", async () => {
    const { review } = await setup();
    const u = await review.diff({ scope: "uncommitted" });
    expect(u.files.map(f => [f.path, f.status, f.additions, f.deletions]).sort()).toEqual([
      ["a.txt", "modified", 1, 0],
      ["draft.md", "added", 1, 0],
    ]);
    const first = u.commits.find(c => c.subject === "First turn")!;
    const c = await review.diff({ scope: "commit", commit: first.sha });
    expect(c.commit).toBe(first.sha);
    expect(c.files.map(f => f.path).sort()).toEqual(["a.txt", "gone.txt", "logo.bin", "new name.txt"]);
    const a = c.files.find(f => f.path === "a.txt")!;
    expect(a.hunks[0]!.lines.filter(l => l.startsWith("+"))).toEqual(["+THREE"]);
  });

  it("gives more context for one file on request", async () => {
    const { review } = await setup();
    const narrow = await review.diff({ scope: "uncommitted", path: "a.txt" });
    expect(narrow.files).toHaveLength(1);
    expect(narrow.files[0]!.hunks[0]!.lines.length).toBeLessThan(11);
    const wide = await review.diff({ scope: "uncommitted", path: "a.txt", context: 1000 });
    expect(wide.files[0]!.hunks[0]!.lines).toHaveLength(11);
  });

  it("caps files and patch sizes", async () => {
    const { dir, review } = await setup({ maxFiles: 2, maxFileBytes: 40, maxTotalBytes: 1_000_000 });
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    const d = await review.diff({ scope: "uncommitted" });
    expect(d.files).toHaveLength(2);
    expect(d.moreFiles).toBe(1);
    const big = d.files.find(f => f.path === "big.txt");
    if (big) expect(big.truncated).toBe(true);
    expect(d.files.some(f => f.truncated)).toBe(true);
  });

  it("refuses refs and paths that start with '-'", async () => {
    const { review } = await setup();
    await expect(review.diff({ scope: "commit", commit: "--output=/tmp/x" })).rejects.toThrow(/Not a usable/);
    await expect(review.diff({ scope: "commit", commit: "HEAD" })).rejects.toThrow(/by its id/);
    await expect(review.diff({ scope: "branch", path: "-p" })).rejects.toThrow(/Not a usable/);
    await expect(review.diff({ scope: "branch", path: "../etc/passwd" })).rejects.toThrow(/Not a usable/);
    expect(() => new GitReview(new GitWorkspace(tempDir()), { branch: "-x", baseBranch: "main", threadId: "t", title: () => "" })).toThrow();
  });

  it("reports status counts, push state and the compare page", async () => {
    const { dir, review } = await setup();
    let s = await review.status();
    expect(s).toMatchObject({ branch: "agent/review1", uncommittedFiles: 2, committedFiles: 4, commits: 2, hasRemote: false, pushed: false, gh: "missing" });
    const remote = tempDir();
    git(remote, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", remote);
    expect(await review.push()).toBeNull();
    s = await review.status();
    expect(s).toMatchObject({ hasRemote: true, pushed: true, unpushed: 0, compareUrl: null });
    git(dir, "remote", "set-url", "origin", "git@github.com:acme/widgets.git");
    s = await review.status();
    expect(s.compareUrl).toBe("https://github.com/acme/widgets/compare/main...agent/review1?expand=1");
  });

  it("opens a pull request with gh, or hands back the compare page without it", async () => {
    const { dir, review, ws } = await setup();
    const remote = tempDir();
    git(remote, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", remote);
    // No gh: pushed, and the compare page (null here: the remote isn't on GitHub).
    expect(await review.createPullRequest({})).toEqual({ pullRequest: null, compareUrl: null });
    expect(git(remote, "rev-parse", "agent/review1")).toBe(git(dir, "rev-parse", "HEAD"));

    const calls: string[][] = [];
    let created = false;
    const gh: GhRunner = async args => {
      calls.push(args);
      if (args[0] === "auth") return "";
      if (args[1] === "create") {
        created = true;
        return "https://github.com/acme/widgets/pull/7\n";
      }
      if (!created) throw new Error("no pull requests found");
      return JSON.stringify({ url: "https://github.com/acme/widgets/pull/7", number: 7, state: "OPEN", isDraft: true, statusCheckRollup: [] });
    };
    const withGh = new GitReview(ws, { branch: "agent/review1", baseBranch: "main", threadId: "review1", title: () => "Tidy the widgets", gh });
    const r = await withGh.createPullRequest({ draft: true });
    expect(r.pullRequest).toMatchObject({ url: "https://github.com/acme/widgets/pull/7", state: "open", draft: true, checks: "none" });
    const create = calls.find(c => c[1] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--head", "agent/review1", "--base", "main", "--title", "Tidy the widgets", "--draft"]));
  });
});

describe("parsing git output", () => {
  it("reads name-status and numstat with renames", () => {
    expect(parseNameStatus("M\0a.txt\0R087\0old.txt\0new.txt\0A\0b c.txt\0")).toEqual([
      { status: "modified", path: "a.txt" },
      { status: "renamed", oldPath: "old.txt", path: "new.txt" },
      { status: "added", path: "b c.txt" },
    ]);
    const n = parseNumstat("1\t2\ta.txt\0" + "3\t0\t\0old.txt\0new.txt\0" + "-\t-\timg.png\0");
    expect(n.get("a.txt")).toEqual({ additions: 1, deletions: 2, binary: false });
    expect(n.get("new.txt")).toEqual({ additions: 3, deletions: 0, binary: false });
    expect(n.get("img.png")).toEqual({ additions: 0, deletions: 0, binary: true });
  });

  it("splits patches and parses hunks within a byte limit", () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -10 +10 @@\n-y\n+z\ndiff --git a/y b/y\n";
    const parts = splitPatch(patch);
    expect(parts).toHaveLength(2);
    const { hunks, truncated } = parseHunks(parts[0]!, 10_000);
    expect(truncated).toBe(false);
    expect(hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 2, 1, 2],
      [10, 1, 10, 1],
    ]);
    expect(parseHunks(parts[0]!, 30)).toMatchObject({ truncated: true });
    expect(countPorcelain(" M a.txt\0R  new.txt\0old.txt\0?? n.md\0")).toBe(3);
  });

  it("sums up pull request checks", () => {
    expect(rollupChecks([])).toBe("none");
    expect(rollupChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("passing");
    expect(rollupChecks([{ status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
    expect(rollupChecks([{ state: "PENDING" }])).toBe("pending");
    expect(rollupChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "QUEUED" }])).toBe("failing");
    expect(parseGhPullRequest({ url: "u", state: "MERGED", isDraft: false })).toMatchObject({ state: "merged", draft: false, checks: "none" });
    expect(parseGhPullRequest(null)).toBeNull();
  });
});

describe("compare page", () => {
  it("is built from GitHub remotes in every form, without credentials", () => {
    expect(githubRepoWebUrl("https://github.com/acme/widgets.git")).toBe("https://github.com/acme/widgets");
    expect(githubRepoWebUrl("https://x-access-token:secret@github.com/acme/widgets")).toBe("https://github.com/acme/widgets");
    expect(githubRepoWebUrl("git@github.com:acme/widgets.git")).toBe("https://github.com/acme/widgets");
    expect(githubRepoWebUrl("ssh://git@github.com:22/acme/widgets.git")).toBe("https://github.com/acme/widgets");
    expect(githubRepoWebUrl("https://github.example.com/acme/widgets")).toBe("https://github.example.com/acme/widgets");
    expect(githubRepoWebUrl("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(githubRepoWebUrl("/Users/me/code/widgets")).toBeNull();
    expect(githubRepoWebUrl("https://github.com/acme")).toBeNull();
    expect(compareUrlFor("git@github.com:acme/widgets.git", "main", "agent/abc 1")).toBe(
      "https://github.com/acme/widgets/compare/main...agent/abc%201?expand=1",
    );
    expect(compareUrlFor("https://gitlab.com/a/b", "main", "x")).toBeNull();
  });
});

describe("the runner's /git API", () => {
  it("answers client tokens only, and refuses option-like refs", async () => {
    const { branchForThread, signToken } = await import("@lemonlime/protocol");
    const { startServer, ThreadRunner } = await import("../src/index.ts");
    const dir = tempDir();
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    const SECRET = "thread-secret-for-tests-0123456789";
    const now = new Date().toISOString();
    const id = "git-api-thread-1";
    const runner = new ThreadRunner({
      thread: {
        id,
        title: "",
        agent: { kind: "claude-code" },
        repo: { url: dir, baseBranch: "main" },
        branch: branchForThread(id),
        mode: "local",
        status: "idle",
        sandboxSize: "small",
        latestSeq: 0,
        createdAt: now,
        updatedAt: now,
      },
      workdir: dir,
      dataDir: null,
      adapter: { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) },
      session: { autonomy: "full" },
      bundledSkills: false,
    });
    await runner.init();
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    try {
      writeFileSync(join(dir, "a.txt"), "two\n");
      const base = `http://127.0.0.1:${server.port}`;
      const sign = (scope: "client" | "runner") => signToken({ threadId: id, scope, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
      expect((await fetch(`${base}/git/status`)).status).toBe(401);
      expect((await fetch(`${base}/git/status`, { headers: { authorization: `Bearer ${await sign("runner")}` } })).status).toBe(401);
      const auth = { authorization: `Bearer ${await sign("client")}` };
      const status = await fetch(`${base}/git/status`, { headers: auth });
      expect(await status.json()).toMatchObject({ branch: `agent/${id}`, uncommittedFiles: 1 });
      const diff = (await (await fetch(`${base}/git/diff?scope=uncommitted`, { headers: auth })).json()) as { files: { path: string }[] };
      expect(diff.files.map(f => f.path)).toEqual(["a.txt"]);
      expect((await fetch(`${base}/git/diff?scope=commit&commit=--output%3D%2Ftmp%2Fx`, { headers: auth })).status).toBe(400);
      expect((await fetch(`${base}/git/diff?scope=nope`, { headers: auth })).status).toBe(400);
    } finally {
      await server.close();
      await runner.close();
    }
  });
});
