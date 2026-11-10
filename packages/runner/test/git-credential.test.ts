import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, verifyToken, type Thread, deriveAgentKey } from "@lemonlime/protocol";
import { credentialHelperCommand, gitCredential, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-gitcred-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir })
    .toString()
    .trim();

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
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
}
const editing: AgentAdapter = {
  kind: "claude-code",
  createSession: opts => ({
    runTurn: async ctx => writeFileSync(join(opts.cwd, "notes.md"), `${ctx.prompt}\n`),
    saveState: () => ({}),
    dispose: async () => {},
  }),
};

/** An agent that commits its own work, as the bundled git skill asks agents to. */
const committing: AgentAdapter = {
  kind: "codex",
  createSession: opts => ({
    runTurn: async ctx => {
      writeFileSync(join(opts.cwd, "LAUNCH_CHECK.md"), `${ctx.prompt}\n`);
      execFileSync("git", ["add", "LAUNCH_CHECK.md"], { cwd: opts.cwd });
      execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.test", "commit", "-qm", "Add launch check note"], { cwd: opts.cwd });
    },
    saveState: () => ({}),
    dispose: async () => {},
  }),
};

describe("git credential helper", () => {
  it("hands git a fresh token from the control plane, and nothing when there is none", async () => {
    const secret = "thread-secret-for-credential-tests";
    let answer: { status: number; body: unknown } = {
      status: 200,
      body: { username: "x-access-token", password: "ghs_fresh", expiresAt: "2026-01-01T00:00:00Z" },
    };
    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      const ok = await verifyToken((req.headers.authorization ?? "").replace("Bearer ", ""), await deriveAgentKey(secret));
      seen.push(`${req.url} ${ok.ok && ok.claims.scope}`);
      res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>(r => server.close(() => r())));
    const env = {
      LEMONLIME_THREAD_ID: "cred-thread-1",
      LEMONLIME_AGENT_KEY: await deriveAgentKey(secret),
      LEMONLIME_CONTROL_PLANE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };

    const request = "protocol=https\nhost=github.com\npath=acme/app.git\n";
    expect(await gitCredential("get", request, env)).toBe("username=x-access-token\npassword=ghs_fresh\n");
    expect(seen).toEqual(["/api/runner/git-credentials?threadId=cred-thread-1&host=github.com runner"]);
    answer = { status: 404, body: { error: "not_found" } };
    expect(await gitCredential("get", request, env)).toBe("");
    expect(await gitCredential("get", "protocol=ssh\nhost=github.com\n", env)).toBe("");
    expect(await gitCredential("get", "protocol=https\n", env)).toBe("");
    expect(await gitCredential("store", request, env)).toBe("");
    expect(await gitCredential("get", request, {})).toBe("");
  });

  it("quotes paths with spaces for git", () => {
    expect(credentialHelperCommand(["/usr/bin/node", "/opt/my apps/lemonlime-runner.js", "git-credential"])).toBe(
      "!'/usr/bin/node' '/opt/my apps/lemonlime-runner.js' 'git-credential'",
    );
  });
});

describe("pushing the thread branch", () => {
  it("pushes after every turn that commits, and says so when it can't", async () => {
    const origin = temp();
    git(origin, "init", "-q", "--bare", "-b", "main");
    const seed = temp();
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "hi\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", origin, "main");

    const work = join(temp(), "w");
    const runner = new ThreadRunner({
      thread: thread("push-thread-1"),
      workdir: work,
      dataDir: null,
      adapter: editing,
      session: { autonomy: "full" },
      repoUrl: origin,
      pushBranch: true,
      credentialHelper: credentialHelperCommand(),
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    const helpers = execFileSync("git", ["config", "--local", "--get-all", "credential.helper"], { cwd: work }).toString();
    // An empty entry first clears helpers from system or global config (like a keychain).
    expect(helpers).toBe(`\n${credentialHelperCommand()}\n`);

    runner.sendMessage("first");
    await runner.settled();
    expect(git(origin, "show", "agent/push-thread-1:notes.md")).toBe("first");

    // The remote refuses (here: it's gone); the thread says so and keeps the commit.
    rmSync(origin, { recursive: true, force: true });
    runner.sendMessage("second");
    await runner.settled();
    const notice = runner.store.since(0).find(e => e.type === "notice" && e.code === "push_failed");
    expect(notice).toBeDefined();
    expect(git(work, "log", "-1", "--format=%s")).toBe("second");
  });

  it("also pushes a turn where the agent committed its work itself", async () => {
    const origin = temp();
    git(origin, "init", "-q", "--bare", "-b", "main");
    const seed = temp();
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "hi\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", origin, "main");

    const runner = new ThreadRunner({
      thread: thread("push-thread-2"),
      workdir: join(temp(), "w"),
      dataDir: null,
      adapter: committing,
      session: { autonomy: "full" },
      repoUrl: origin,
      pushBranch: true,
      credentialHelper: credentialHelperCommand(),
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    runner.sendMessage("Cloud launch check");
    await runner.settled();
    // Nothing was left uncommitted, but the agent's own commit reaches GitHub.
    expect(git(origin, "log", "-1", "--format=%s", "agent/push-thread-2")).toBe("Add launch check note");
    expect(git(origin, "show", "agent/push-thread-2:LAUNCH_CHECK.md")).toBe("Cloud launch check");
    expect(runner.store.since(0).some(e => e.type === "notice" && e.code === "push_failed")).toBe(false);
  });
});

describe("cloning the thread's repository", () => {
  it("clones even when the runner's data folder is already in the working folder (as in a sandbox)", async () => {
    const origin = temp();
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "README.md"), "hello\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "init");
    const work = temp();
    const runner = new ThreadRunner({
      thread: { ...thread("clone-thread-1"), repo: { url: origin, baseBranch: "main" } },
      workdir: work,
      // The default for sandboxes: history and state inside the working folder.
      dataDir: join(work, ".lemonlime"),
      adapter: editing,
      session: { autonomy: "full" },
      repoUrl: origin,
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("hello\n");
    expect(git(work, "branch", "--show-current")).toBe("agent/clone-thread-1");
    expect(git(work, "log", "-1", "--format=%s")).toBe("init");
  });
});
