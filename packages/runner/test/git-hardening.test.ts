import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/index.ts";
import { assertSafePath, assertSafeRef } from "../src/git.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-harden-"));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
    .toString()
    .trim();

/** A script that leaves `marker` behind when something runs it. */
function trap(dir: string, marker: string): string {
  const script = join(dir, "trap.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  chmodSync(script, 0o755);
  return script;
}

function repo(): { dir: string; marker: string; script: string } {
  const dir = tempDir();
  const outside = tempDir();
  const marker = join(outside, "ran");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, marker, script: trap(outside, marker) };
}

describe.skipIf(process.platform === "win32")("the runner's git calls ignore programs named in the repo's config", () => {
  it("never starts core.fsmonitor", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "core.fsmonitor", script);
    // Plain git does run it, so the test would notice if the runner did too.
    git(dir, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/fsmon1", "main");
    writeFileSync(join(dir, "a.txt"), "two\n");
    await ws.collectChanges();
    await ws.commit("Change");
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs hooks", async () => {
    const { dir, marker, script } = repo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-checkout", "post-commit", "pre-commit", "reference-transaction"]) {
      writeFileSync(join(dir, ".git", "hooks", hook), `#!/bin/sh\nexec "${script}"\n`);
      chmodSync(join(dir, ".git", "hooks", hook), 0o755);
    }
    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/hooks1", "main");
    writeFileSync(join(dir, "b.txt"), "new\n");
    await ws.collectChanges();
    await ws.commit("Add b");
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs an external diff or a textconv filter", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "diff.external", script);
    git(dir, "config", "diff.evil.textconv", script);
    writeFileSync(join(dir, ".gitattributes"), "*.txt diff=evil\n");
    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/diffs1", "main");
    writeFileSync(join(dir, "a.txt"), "two\n");
    const changes = await ws.collectChanges();
    expect(changes.find(c => c.path === "a.txt")?.diff).toContain("+two");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("refs and paths from outside", () => {
  it("refuses anything git could read as an option", async () => {
    for (const bad of ["-x", "--upload-pack=touch /tmp/x", "", "a b", "a..b", "x\n"]) expect(() => assertSafeRef(bad)).toThrow();
    expect(assertSafeRef("agent/abc-123")).toBe("agent/abc-123");
    expect(assertSafeRef("0123abcd")).toBe("0123abcd");
    for (const bad of ["-p", "--output=/tmp/x", "/etc/passwd", "../up", "a/../../b", ""]) expect(() => assertSafePath(bad)).toThrow();
    expect(assertSafePath("src/a file.ts")).toBe("src/a file.ts");

    const { dir } = repo();
    const ws = new GitWorkspace(dir);
    await expect(ws.ensureBranch("--orphan", "main")).rejects.toThrow(/Not a usable/);
    await expect(ws.resolveBase("--all")).rejects.toThrow(/Not a usable/);
    await expect(ws.rewindTo("--hard", "refs/x")).rejects.toThrow(/Not a usable/);
  });
});
