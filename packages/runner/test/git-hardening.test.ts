import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitWorkspace } from "../src/index.ts";
import { listWorkdirFiles } from "../src/composer.ts";
import { assertSafePath, assertSafeRef, runGit } from "../src/git.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-harden-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});

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
    // Listing files for the composer is a git call too.
    expect(await listWorkdirFiles(dir)).toContain("a.txt");
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a command written as a remote's address", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "protocol.ext.allow", "always");
    git(dir, "remote", "add", "origin", `ext::${script}`);
    // Plain git does run it, so the test would notice if the runner did too.
    try {
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: dir, stdio: "ignore" });
    } catch {
      // The script isn't a git server, so the fetch fails after running it.
    }
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const ws = new GitWorkspace(dir);
    expect(await ws.fetch("origin", [])).toMatch(/not allowed/);
    expect(await ws.push("main")).toMatch(/not allowed/);
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

/** Git config that stands in for the user's own (their global config), with these settings. */
function usersConfig(...settings: [string, string][]): void {
  const file = join(tempDir(), "gitconfig");
  writeFileSync(file, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", file);
  for (const [key, value] of settings) execFileSync("git", ["config", "--global", "--add", key, value]);
}

/**
 * Plain git, the way the agent or anyone else would run it. The stand-in programs aren't
 * what git expects, so the call may fail after running them; that is fine.
 */
function plainGit(dir: string, ...args: string[]): Promise<void> {
  return new Promise(done => {
    execFile(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd: dir, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      () => done(),
    );
  });
}

/** A second program that leaves its own marker behind, standing in for one the user set up. */
function usersProgram(body = "exit 0"): { script: string; ran: () => boolean } {
  const dir = tempDir();
  const marker = join(dir, "ran");
  const script = join(dir, "program.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n${body}\n`);
  chmodSync(script, 0o755);
  return { script, ran: () => existsSync(marker) };
}

function bareRepo(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

describe.skipIf(process.platform === "win32")("settings in the repository's own config that name a program", () => {
  beforeEach(() => usersConfig());

  it("never runs its ssh command, and uses the user's own", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "core.sshCommand", script);
    git(dir, "remote", "add", "origin", "ssh://git@host.invalid/app.git");
    await plainGit(dir, "fetch", "-q", "origin");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const mine = usersProgram();
    usersConfig(["core.sshCommand", mine.script]);
    const ws = new GitWorkspace(dir);
    await ws.fetch("origin", []);
    await ws.push("main");
    expect(existsSync(marker)).toBe(false);
    expect(mine.ran()).toBe(true);

    // With nothing in the user's config, it is whatever ssh the runner was started with.
    const fromEnv = usersProgram();
    usersConfig();
    vi.stubEnv("GIT_SSH", fromEnv.script);
    await ws.fetch("origin", []);
    expect(existsSync(marker)).toBe(false);
    expect(fromEnv.ran()).toBe(true);
  });

  it("never runs its credential helper, and asks the user's own or the runner's", async () => {
    const server = createServer((_req, res) => res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end());
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    try {
      const { dir, marker, script } = repo();
      git(dir, "remote", "add", "origin", `http://127.0.0.1:${(server.address() as AddressInfo).port}/app.git`);
      git(dir, "config", "credential.helper", `!${script}`);
      git(dir, "config", "credential.http://127.0.0.1.helper", `!${script}`);
      await plainGit(dir, "fetch", "-q", "origin");
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const mine = usersProgram();
      usersConfig(["credential.helper", `!${mine.script}`]);
      expect(await new GitWorkspace(dir).fetch("origin", [])).not.toBeNull();
      expect(existsSync(marker)).toBe(false);
      expect(mine.ran()).toBe(true);

      // A cloud thread's runner has a helper of its own, and uses only that.
      const runners = usersProgram();
      const others = usersProgram();
      usersConfig(["credential.helper", `!${others.script}`]);
      const cloud = new GitWorkspace(dir, `!${runners.script}`);
      expect(await cloud.fetch("origin", [])).not.toBeNull();
      expect(await cloud.push("main")).not.toBeNull();
      expect(runners.ran()).toBe(true);
      expect(others.ran()).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("never runs the programs it names for talking to a remote", async () => {
    const { dir, marker, script } = repo();
    git(dir, "remote", "add", "origin", bareRepo());
    git(dir, "config", "remote.origin.uploadpack", script);
    git(dir, "config", "remote.origin.receivepack", script);
    await plainGit(dir, "fetch", "-q", "origin");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const ws = new GitWorkspace(dir);
    expect(await ws.push("main")).toBeNull();
    expect(await ws.fetch("origin", [])).toBeNull();
    expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs its content filters, and still runs large-file storage", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "filter.evil.clean", script);
    git(dir, "config", "filter.evil.smudge", script);
    git(dir, "config", "filter.evil.process", script);
    git(dir, "config", "filter.evil.required", "true");
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n*.bin filter=lfs\n");
    writeFileSync(join(dir, "a.txt"), "two\n");
    await plainGit(dir, "add", "-A");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    // Large-file storage as it installs itself into a repository, with a stand-in program.
    const bin = tempDir();
    const lfsRan = join(bin, "lfs-ran");
    writeFileSync(join(bin, "git-lfs"), `#!/bin/sh\ntouch "${lfsRan}"\ncat\n`);
    chmodSync(join(bin, "git-lfs"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    git(dir, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    git(dir, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    git(dir, "config", "filter.lfs.required", "true");
    writeFileSync(join(dir, "big.bin"), "large\n");

    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/filter1", "main");
    writeFileSync(join(dir, "a.txt"), "three\n");
    const changes = await ws.collectChanges();
    expect(changes.map(c => c.path).sort()).toEqual([".gitattributes", "a.txt", "big.bin"]);
    expect(await ws.commit("Change")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "show", "HEAD:a.txt")).toBe("three");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lfsRan)).toBe(true);

    // The same name with some other program behind it is not large-file storage.
    git(dir, "config", "filter.lfs.clean", script);
    writeFileSync(join(dir, "big.bin"), "larger\n");
    await ws.collectChanges();
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs its merge driver: the file is reported as a conflict", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "merge.evil.driver", `${script} %A`);
    writeFileSync(join(dir, ".gitattributes"), "a.txt merge=evil\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "attributes");
    git(dir, "checkout", "-q", "-b", "other");
    writeFileSync(join(dir, "a.txt"), "theirs\n");
    git(dir, "commit", "-q", "-am", "theirs");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "mine\n");
    git(dir, "commit", "-q", "-am", "mine");
    await plainGit(dir, "merge", "-q", "--no-commit", "other");
    await plainGit(dir, "merge", "--abort");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(await new GitWorkspace(dir).mergeFrom("other", "Merge other")).toEqual({ result: "conflicts", conflicts: ["a.txt"] });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(marker)).toBe(false);
  });

  it("signs commits only when the user's own config asks, with the user's own program", async () => {
    const { dir, marker, script } = repo();
    git(dir, "config", "commit.gpgsign", "true");
    git(dir, "config", "gpg.program", script);
    git(dir, "config", "user.signingkey", "ABCDEF");
    await plainGit(dir, "commit", "-q", "--allow-empty", "-m", "signed?");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/sign1", "main");
    writeFileSync(join(dir, "a.txt"), "two\n");
    await ws.collectChanges();
    expect(await ws.commit("Not signed")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "cat-file", "commit", "HEAD")).not.toContain("gpgsig");
    expect(existsSync(marker)).toBe(false);

    const mine = usersProgram(
      'cat > /dev/null\nprintf "\\n[GNUPG:] SIG_CREATED \\n" >&2\necho "-----BEGIN PGP SIGNATURE-----"\necho "-----END PGP SIGNATURE-----"',
    );
    usersConfig(["commit.gpgsign", "true"], ["gpg.program", mine.script]);
    writeFileSync(join(dir, "a.txt"), "three\n");
    await ws.collectChanges();
    expect(await ws.commit("Signed")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "cat-file", "commit", "HEAD")).toContain("gpgsig");
    expect(mine.ran()).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a command set as a submodule's way of updating", async () => {
    const { dir, marker, script } = repo();
    const library = tempDir();
    git(library, "init", "-q", "-b", "main");
    writeFileSync(join(library, "lib.txt"), "lib\n");
    git(library, "add", "-A");
    git(library, "commit", "-q", "-m", "lib");
    git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
    git(dir, "commit", "-q", "-m", "Add lib");
    const recorded = git(join(dir, "lib"), "rev-parse", "HEAD");
    // The submodule has moved on, so updating it has something to do.
    git(join(dir, "lib"), "commit", "-q", "--allow-empty", "-m", "ahead");
    git(dir, "config", "submodule.lib.update", `!${script}`);
    await plainGit(dir, "submodule", "update");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(await new GitWorkspace(dir).fillSubmodules()).toEqual([]);
    expect(git(join(dir, "lib"), "rev-parse", "HEAD")).toBe(recorded);
    expect(existsSync(marker)).toBe(false);
  });

  it("sees settings pulled in from another file", async () => {
    const { dir, marker, script } = repo();
    const elsewhere = join(tempDir(), "extra");
    writeFileSync(elsewhere, `[remote "origin"]\n\tuploadpack = ${script}\n`);
    git(dir, "remote", "add", "origin", bareRepo());
    git(dir, "config", "include.path", elsewhere);
    await plainGit(dir, "fetch", "-q", "origin");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(await new GitWorkspace(dir).fetch("origin", [])).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it("won't fetch or push while the repository sends addresses somewhere else", async () => {
    const { dir } = repo();
    const real = bareRepo();
    const other = bareRepo();
    git(dir, "remote", "add", "origin", real);
    git(dir, "config", `url.${other}.insteadOf`, real);
    const ws = new GitWorkspace(dir);
    expect(await ws.push("main")).toMatch(/own git settings send addresses somewhere else/);
    expect(await ws.fetch("origin", [])).toMatch(/own git settings send addresses somewhere else/);
    expect(() => git(other, "rev-parse", "--verify", "-q", "refs/heads/main")).toThrow();
    // Everything that stays on this machine carries on.
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect((await ws.collectChanges()).map(c => c.path)).toEqual(["a.txt"]);
  });

  it("trusts a server the user's way, whatever the repository's own settings say", async () => {
    const { dir } = repo();
    git(dir, "config", "http.sslVerify", "false");
    git(dir, "config", "http.followRedirects", "true");
    git(dir, "config", "http.https://git.example.com/.sslVerify", "false");
    expect(git(dir, "config", "--get", "http.sslVerify")).toBe("false");
    // What git goes by in one of the runner's own calls.
    const used = async (key: string) => (await runGit(["config", "--get", key], { cwd: dir })).stdout.trim();
    expect(await used("http.sslVerify")).toBe("true");
    expect(await used("http.followRedirects")).toBe("initial");
    expect(await used("http.https://git.example.com/.sslVerify")).toBe("true");

    // The user's own choice stands, for every address and for one.
    usersConfig(["http.sslVerify", "false"]);
    expect(await used("http.sslVerify")).toBe("false");
    expect(await used("http.https://git.example.com/.sslVerify")).toBe("false");
    usersConfig(["http.https://git.example.com/.sslVerify", "false"], ["http.followRedirects", "false"]);
    expect(await used("http.sslVerify")).toBe("true");
    expect(await used("http.https://git.example.com/.sslVerify")).toBe("false");
    expect(await used("http.followRedirects")).toBe("false");
  });

  it("won't fetch or push while the repository names the certificates to trust", async () => {
    const { dir } = repo();
    const remote = bareRepo();
    git(dir, "remote", "add", "origin", remote);
    git(dir, "config", "http.sslCAInfo", join(tempDir(), "their-ca.pem"));
    const ws = new GitWorkspace(dir);
    expect(await ws.push("main")).toMatch(/own git settings name the certificates to trust/);
    expect(await ws.fetch("origin", [])).toMatch(/own git settings name the certificates to trust/);
    expect(() => git(remote, "rev-parse", "--verify", "-q", "refs/heads/main")).toThrow();
    // Everything that stays on this machine carries on.
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect((await ws.collectChanges()).map(c => c.path)).toEqual(["a.txt"]);

    // With certificates of the user's own, those are the ones used.
    const mine = join(tempDir(), "my-ca.pem");
    usersConfig(["http.sslCAInfo", mine]);
    expect((await runGit(["config", "--get", "http.sslCAInfo"], { cwd: dir })).stdout.trim()).toBe(mine);
    expect(await ws.push("main")).toBeNull();
    expect(git(remote, "rev-parse", "--verify", "-q", "refs/heads/main")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves the repository's settings alone when the runner is told to trust them", async () => {
    const { dir, marker, script } = repo();
    git(dir, "remote", "add", "origin", bareRepo());
    git(dir, "config", "remote.origin.uploadpack", script);
    vi.stubEnv("LEMONLIME_TRUST_REPO_GIT_CONFIG", "1");
    await new GitWorkspace(dir).fetch("origin", []);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("file names with unusual characters", () => {
  it("reports changed files by their real names, with their changes", async () => {
    const { dir } = repo();
    const ws = new GitWorkspace(dir);
    await ws.ensureBranch("agent/names1", "main");
    const odd = ["café menu.txt", "tab\there.txt", 'say "hi".txt'];
    for (const name of odd) writeFileSync(join(dir, name), `in ${name}\n`);
    git(dir, "mv", "a.txt", "ä renamed.txt");
    const changes = await ws.collectChanges();
    for (const name of odd) {
      const change = changes.find(c => c.path === name);
      expect(change?.change).toBe("added");
      expect(change?.diff).toContain(`+in ${name}`);
    }
    expect(changes.find(c => c.path === "ä renamed.txt")?.change).toBe("renamed");
    expect(changes).toHaveLength(odd.length + 1);
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
