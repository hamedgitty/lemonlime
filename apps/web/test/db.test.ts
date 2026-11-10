import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { account, sandboxRuns, threads, workspaceMembers, workspaces } from "@lemonlime/db";
import { IDLE_PAUSE_AFTER_MS, type CreateThreadRequest } from "@lemonlime/protocol";
import { userWorkspaceIds } from "../src/lib/access.ts";
import { generateAccessToken, hashAccessToken } from "../src/lib/access-tokens.ts";
import { createAccessTokenRow, findUserByTokenHash } from "../src/lib/access.ts";
import { createAuth } from "../src/lib/better-auth.ts";
import { HttpError } from "../src/lib/errors.ts";
import {
  createThread,
  deleteThread,
  renameThread,
  getThreadRowForUser,
  listThreads,
  pauseThread,
  recordHeartbeat,
  resumeThread,
  sweepRunningSandboxes,
  getLiveRunnerThread,
  requestAgentSignIn,
} from "../src/lib/threads.ts";
import { signInRequestedRecently } from "../src/lib/agent-credentials.ts";
import { addTeam, addUser, createTestApp } from "./helpers.ts";

const localThread: CreateThreadRequest = {
  agent: { kind: "claude-code" },
  repo: { url: "/home/me/project", baseBranch: "main" },
  mode: "local",
  sandboxSize: "small",
  prompt: "Fix the flaky test\nand more",
};

const cloudThread: CreateThreadRequest = {
  agent: { kind: "codex" },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  mode: "cloud",
  sandboxSize: "large",
};

async function httpStatus(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("sign-up with an email code", () => {
  it("creates the user, a session and a personal workspace they own", async () => {
    const { ctx, db, emails } = await createTestApp();
    const auth = createAuth(ctx);

    await auth.api.sendVerificationOTP({ body: { email: "new@example.com", type: "sign-in" } });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe("new@example.com");
    const code = /\b(\d{6})\b/.exec(emails[0]!.text)?.[1];
    expect(code).toMatch(/^\d{6}$/);

    // A wrong code does not sign in.
    await expect(auth.api.signInEmailOTP({ body: { email: "new@example.com", otp: code === "000000" ? "111111" : "000000" } })).rejects.toThrow();

    const result = await auth.api.signInEmailOTP({ body: { email: "new@example.com", otp: code! } });
    expect(result.user.email).toBe("new@example.com");
    expect(result.token).toBeTruthy();

    const members = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, result.user.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe("owner");
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, members[0]!.workspaceId));
    expect(ws).toMatchObject({ name: "new", personal: true, createdBy: result.user.id });
    expect(await userWorkspaceIds(db, result.user.id)).toEqual([ws!.id]);

    // The session cookie value resolves back to the user.
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: `better-auth.session_token=${await signedCookie(ctx.vars.BETTER_AUTH_SECRET!, result.token)}` }),
    });
    expect(session?.user.id).toBe(result.user.id);

    // Signing in again does not create a second workspace.
    await auth.api.sendVerificationOTP({ body: { email: "new@example.com", type: "sign-in" } });
    const code2 = /\b(\d{6})\b/.exec(emails[1]!.text)?.[1] ?? "";
    await auth.api.signInEmailOTP({ body: { email: "new@example.com", otp: code2 } });
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, result.user.id))).toHaveLength(1);
  });
});

/** Better Auth signs its session cookie as `<token>.<base64 HMAC-SHA256>`. */
async function signedCookie(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...sig))}`);
}

describe("threads, scoped to a workspace", () => {
  it("creates, lists, reads and closes local threads", async () => {
    const { ctx } = await createTestApp();
    const alice = await addUser(ctx.db, "alice@example.com");
    const bob = await addUser(ctx.db, "bob@example.com");

    const created = await createThread(ctx, alice.userId, alice.workspaceId, localThread);
    expect(created.thread).toMatchObject({ title: "Fix the flaky test", mode: "local", status: "idle", sandboxSize: "small" });
    expect(created.thread.branch).toBe(`agent/${created.thread.id}`);
    expect(created.endpoint).toBeNull();
    expect(created.initialPrompt).toBe("Fix the flaky test\nand more");

    expect((await listThreads(ctx, alice.userId, alice.workspaceId)).map(t => t.id)).toEqual([created.thread.id]);
    expect(await listThreads(ctx, bob.userId, bob.workspaceId)).toEqual([]);
    expect(await httpStatus(listThreads(ctx, bob.userId, alice.workspaceId))).toBe(403);
    expect(await httpStatus(getThreadRowForUser(ctx, bob.userId, created.thread.id))).toBe(404);
    expect(await httpStatus(deleteThread(ctx, bob.userId, created.thread.id))).toBe(404);

    // Renaming: members only, and the name is tidied.
    expect(await httpStatus(renameThread(ctx, bob.userId, created.thread.id, "Mine now"))).toBe(404);
    expect(await httpStatus(renameThread(ctx, alice.userId, created.thread.id, "   "))).toBe(400);
    expect((await renameThread(ctx, alice.userId, created.thread.id, "  Fix the\n flaky test  ")).thread.title).toBe("Fix the flaky test");

    const closed = await deleteThread(ctx, alice.userId, created.thread.id);
    expect(closed.thread.status).toBe("stopped");
  });

  it("serves runner routes only while the cloud thread is meant to be running", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const { thread } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    expect((await getLiveRunnerThread(ctx, thread.id)).id).toBe(thread.id);
    await pauseThread(ctx, alice.userId, thread.id);
    expect(await httpStatus(getLiveRunnerThread(ctx, thread.id))).toBe(404);
    const local = await createThread(ctx, alice.userId, alice.workspaceId, { ...cloudThread, mode: "local" });
    expect(await httpStatus(getLiveRunnerThread(ctx, local.thread.id))).toBe(404);
  });

  it("passes what the runner reports about CPU use to the usage policy", async () => {
    const seen: unknown[] = [];
    const { ctx, db } = await createTestApp({
      policy: {
        async canKeepRunning(sandbox) {
          seen.push(sandbox.activity);
          return sandbox.activity?.topProcess === "xmrig" ? { allow: false, reason: "Looks like mining." } : { allow: true };
        },
      },
    });
    const alice = await addUser(db, "alice@example.com");
    const { thread } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    const beat = { threadId: thread.id, status: "running" as const, latestSeq: 1, idleSince: null, runnerVersion: "test" };
    await recordHeartbeat(ctx, { ...beat, load: { cpuCores: 0.4, topProcess: "node" } });
    expect(await sweepRunningSandboxes(ctx)).toMatchObject({ paused: [] });
    expect(seen[0]).toMatchObject({ agentWorking: true, cpuCores: 0.4, topProcess: "node" });
    await recordHeartbeat(ctx, { ...beat, load: { cpuCores: 1, topProcess: "xmrig" } });
    // Denied: drained first, like any pause, so nothing the agent did is lost.
    expect(await sweepRunningSandboxes(ctx)).toMatchObject({ paused: [], draining: [thread.id] });
  });

  it("runs cloud threads through the usage policy and records each run once", async () => {
    const decisions: Array<{ allow: boolean }> = [];
    const stopped: string[] = [];
    let allow = true;
    const { ctx, db, sandbox } = await createTestApp({
      policy: {
        async canStartSandbox() {
          decisions.push({ allow });
          return allow ? { allow: true } : { allow: false, reason: "Not right now." };
        },
        async onSandboxStopped(run) {
          stopped.push(run.endReason);
        },
      },
    });
    const alice = await addUser(db, "alice@example.com");
    const bob = await addUser(db, "bob@example.com");

    const created = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    const id = created.thread.id;
    expect(sandbox.calls).toEqual([`create:${id}`]);
    expect(created.endpoint?.url).toBe("ws://127.0.0.1:9000/sb-1/ws");

    // Other users can neither pause nor resume it.
    expect(await httpStatus(pauseThread(ctx, bob.userId, id))).toBe(404);

    const paused = await pauseThread(ctx, alice.userId, id);
    expect(paused.thread.status).toBe("paused");
    expect(paused.endpoint).toBeNull();
    // Pausing again is a no-op and records nothing more.
    await pauseThread(ctx, alice.userId, id);
    expect(await db.select().from(sandboxRuns).where(eq(sandboxRuns.threadId, id))).toHaveLength(1);
    expect(stopped).toEqual(["user"]);

    allow = false;
    const denied = await resumeThread(ctx, alice.userId, id).catch(e => e);
    expect(denied).toBeInstanceOf(HttpError);
    expect(denied.status).toBe(402);
    expect(denied.body).toEqual({ error: "policy_denied", reason: "Not right now." });

    allow = true;
    const resumed = await resumeThread(ctx, alice.userId, id);
    expect(resumed.thread.status).toBe("provisioning");
    expect(sandbox.calls).toContain("resume:sb-1");

    // Heartbeats update status; once idle long enough the sweep asks the runner to drain,
    // and pauses it once it has, exactly once.
    const idleSince = new Date(Date.now() - IDLE_PAUSE_AFTER_MS - 1000).toISOString();
    expect(await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 7, idleSince, runnerVersion: "test" })).toEqual({
      action: "none",
      pendingMessages: 0,
    });
    expect(await sweepRunningSandboxes(ctx)).toEqual({ checked: 1, paused: [], draining: [id], errors: [] });
    expect(await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 7, idleSince, runnerVersion: "test" })).toMatchObject({ action: "drain" });
    expect(await sweepRunningSandboxes(ctx)).toEqual({ checked: 1, paused: [], draining: [], errors: [] }); // still draining
    expect(await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 8, idleSince, runnerVersion: "test", drained: true })).toMatchObject({
      action: "none",
    });
    const sweep = await sweepRunningSandboxes(ctx);
    expect(sweep).toEqual({ checked: 1, paused: [{ threadId: id, endReason: "idle" }], draining: [], errors: [] });
    expect(await sweepRunningSandboxes(ctx)).toEqual({ checked: 0, paused: [], draining: [], errors: [] });
    expect((await db.select().from(sandboxRuns).where(eq(sandboxRuns.threadId, id))).map(r => r.endReason)).toEqual(["user", "idle"]);

    // A runner that keeps reporting after the pause is asked to shut down.
    expect(await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 9, idleSince, runnerVersion: "test" })).toEqual({
      action: "shutdown",
      pendingMessages: 0,
    });
    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    expect(row).toMatchObject({ status: "paused", latestSeq: 9, runningSince: null });

    const closed = await deleteThread(ctx, alice.userId, id);
    expect(closed.thread.status).toBe("stopped");
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
  });

  it("refuses to start a sandbox when the policy declines", async () => {
    const { ctx, sandbox } = await createTestApp({
      policy: { canStartSandbox: async () => ({ allow: false, reason: "No.", actionUrl: "not a url" }) },
    });
    const alice = await addUser(ctx.db, "alice@example.com");
    const err = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread).catch(e => e);
    expect(err.status).toBe(402);
    // An invalid action link is dropped rather than failing the request.
    expect(err.body).toEqual({ error: "policy_denied", reason: "No." });
    expect(sandbox.calls).toEqual([]);
    expect(await listThreads(ctx, alice.userId, alice.workspaceId)).toEqual([]);
  });
});

describe("threads in a shared workspace", () => {
  async function sharedThread(req: CreateThreadRequest = cloudThread) {
    const app = await createTestApp();
    const owner = await addUser(app.db, "owner@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    const carol = await addUser(app.db, "carol@example.com");
    const teamId = await addTeam(app.db, owner.userId, [bob.userId, carol.userId]);
    const { thread } = await createThread(app.ctx, bob.userId, teamId, req);
    return { ...app, owner, bob, carol, id: thread.id };
  }
  const signInAskedAt = async (db: Awaited<ReturnType<typeof sharedThread>>["db"], id: string) =>
    (await db.select({ at: threads.signInRequestedAt }).from(threads).where(eq(threads.id, id)))[0]!.at;

  it("lets only the person who started a thread sign its agent in", async () => {
    const { ctx, db, owner, bob, carol, id } = await sharedThread();
    // The login would be saved to Bob's account, so nobody else may start it: not even an owner.
    expect(await httpStatus(requestAgentSignIn(ctx, carol.userId, id))).toBe(403);
    expect(await httpStatus(requestAgentSignIn(ctx, owner.userId, id))).toBe(403);
    expect(await signInAskedAt(db, id)).toBeNull();

    await requestAgentSignIn(ctx, bob.userId, id);
    expect(signInRequestedRecently(await signInAskedAt(db, id))).toBe(true);

    const outsider = await addUser(db, "mallory@example.com");
    expect(await httpStatus(requestAgentSignIn(ctx, outsider.userId, id))).toBe(404);
    const local = await createThread(ctx, bob.userId, bob.workspaceId, localThread);
    expect(await httpStatus(requestAgentSignIn(ctx, bob.userId, local.thread.id))).toBe(400);
  });

  it("lets the person who started a thread, or a workspace owner, close it", async () => {
    const { ctx, sandbox, owner, bob, carol, id } = await sharedThread();
    const err = await deleteThread(ctx, carol.userId, id).catch(e => e);
    expect(err).toMatchObject({ status: 403, message: "Only the person who started this thread or a workspace owner can close it." });
    expect(sandbox.calls).toEqual([`create:${id}`]);
    // Everyone in the workspace can still open, pause and resume it.
    expect((await pauseThread(ctx, carol.userId, id)).thread.status).toBe("paused");
    expect((await resumeThread(ctx, carol.userId, id)).endpoint).not.toBeNull();

    expect((await deleteThread(ctx, bob.userId, id)).thread.status).toBe("stopped");
    const second = await sharedThread(localThread);
    expect(await httpStatus(deleteThread(second.ctx, second.carol.userId, second.id))).toBe(403);
    expect((await deleteThread(second.ctx, second.owner.userId, second.id)).thread.status).toBe("stopped");
    expect(owner.userId).not.toBe(second.owner.userId);
  });
});

describe("sandboxes that fail to start or wake", () => {
  const statusOf = async (db: Awaited<ReturnType<typeof createTestApp>>["db"]) =>
    (await db.select({ status: threads.status, sandboxId: threads.sandboxId, runningSince: threads.runningSince }).from(threads))[0];
  const resumes = (calls: string[]) => calls.filter(c => c.startsWith("resume:"));

  it("mark the thread failed and keep the provider's own words out of the answer", async () => {
    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    sandbox.create = async () => {
      throw new Error("403 from registry.internal.example: account acme-prod is over quota");
    };
    const err = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread).catch(e => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 502, message: "Could not start the sandbox. Try again in a moment." });
    // Not left "provisioning" for ever.
    expect(await statusOf(db)).toEqual({ status: "failed", sandboxId: null, runningSince: null });
  });

  it("remove a sandbox that was made but could not be kept track of", async () => {
    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const create = sandbox.create.bind(sandbox);
    sandbox.create = async opts => {
      const info = await create(opts);
      await db.delete(threads); // the thread goes away while its sandbox is being made
      return info;
    };
    expect(await httpStatus(createThread(ctx, alice.userId, alice.workspaceId, cloudThread))).toBe(502);
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
  });

  it("wake a paused sandbox once when it is resumed twice at the same moment", async () => {
    const started: string[] = [];
    const { ctx, db, sandbox } = await createTestApp({ policy: { onSandboxStarted: async s => void started.push(s.sandboxId) } });
    const alice = await addUser(db, "alice@example.com");
    const { thread } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    await pauseThread(ctx, alice.userId, thread.id);
    started.length = 0;

    const both = await Promise.all([resumeThread(ctx, alice.userId, thread.id), resumeThread(ctx, alice.userId, thread.id)]);
    expect(resumes(sandbox.calls)).toEqual(["resume:sb-1"]);
    expect(started).toEqual(["sb-1"]);
    expect(both.map(r => r.thread.status)).toEqual(["provisioning", "provisioning"]);
    expect(both.filter(r => r.endpoint)).not.toHaveLength(0);
  });

  it("tell a second resume that one is under way, and serve the runner only once it is done", async () => {
    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const { thread } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    await pauseThread(ctx, alice.userId, thread.id);

    let reached!: () => void;
    let finish!: () => void;
    const waking = new Promise<void>(r => (reached = r));
    const woken = new Promise<void>(r => (finish = r));
    const resume = sandbox.resume.bind(sandbox);
    sandbox.resume = async (id, runner) => {
      reached();
      await woken;
      return resume(id, runner);
    };
    const first = resumeThread(ctx, alice.userId, thread.id);
    await waking;
    expect(await resumeThread(ctx, alice.userId, thread.id)).toMatchObject({ thread: { status: "provisioning" }, endpoint: null });
    expect(await httpStatus(getLiveRunnerThread(ctx, thread.id))).toBe(404);
    finish();
    expect((await first).endpoint).not.toBeNull();
    expect(resumes(sandbox.calls)).toEqual(["resume:sb-1"]);
    expect((await getLiveRunnerThread(ctx, thread.id)).id).toBe(thread.id);
  });

  it("can be resumed again after waking failed, or after a resume that never finished", async () => {
    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const { thread } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    await pauseThread(ctx, alice.userId, thread.id);

    const resume = sandbox.resume.bind(sandbox);
    sandbox.resume = async () => {
      throw new Error("sandbox sb-1 not found on host 10.0.0.5");
    };
    const err = await resumeThread(ctx, alice.userId, thread.id).catch(e => e);
    expect(err).toMatchObject({ status: 502, message: "Could not resume the sandbox. Try again in a moment." });
    expect(await statusOf(db)).toEqual({ status: "paused", sandboxId: "sb-1", runningSince: null });

    // A resume that died part-way leaves the thread "provisioning": it is left alone for a
    // couple of minutes, then anyone may try again.
    sandbox.resume = resume;
    await db.update(threads).set({ status: "provisioning" });
    expect((await resumeThread(ctx, alice.userId, thread.id)).endpoint).toBeNull();
    expect(resumes(sandbox.calls)).toEqual([]);
    await db.update(threads).set({ updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect((await resumeThread(ctx, alice.userId, thread.id)).endpoint).not.toBeNull();
    expect(resumes(sandbox.calls)).toEqual(["resume:sb-1"]);
  });
});

describe("runner heartbeats", () => {
  it("only take the statuses a runner can report, and only for cloud threads", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const { thread } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    const beat = { threadId: thread.id, latestSeq: 3, idleSince: null, runnerVersion: "test" };
    for (const status of ["paused", "stopped", "failed"] as const) {
      expect(await httpStatus(recordHeartbeat(ctx, { ...beat, status }))).toBe(400);
    }
    const [row] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(row).toMatchObject({ status: "provisioning", latestSeq: 0, lastHeartbeatAt: null });
    expect(await recordHeartbeat(ctx, { ...beat, status: "running" })).toEqual({ action: "none", pendingMessages: 0 });

    // A local thread's runner is on someone's own computer and never reports here.
    const local = await createThread(ctx, alice.userId, alice.workspaceId, localThread);
    expect(await httpStatus(recordHeartbeat(ctx, { ...beat, threadId: local.thread.id, status: "running" }))).toBe(404);
    const [untouched] = await db.select().from(threads).where(eq(threads.id, local.thread.id));
    expect(untouched).toMatchObject({ status: "idle", latestSeq: 0 });
  });
});

describe("personal access tokens", () => {
  it("finds the owner by the token's hash and records use", async () => {
    const { db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const raw = generateAccessToken();
    const row = await createAccessTokenRow(db, alice.userId, "desktop", hashAccessToken(raw));
    expect(row.lastUsedAt).toBeNull();

    expect(await findUserByTokenHash(db, hashAccessToken(raw))).toBe(alice.userId);
    expect(await findUserByTokenHash(db, hashAccessToken(generateAccessToken()))).toBeNull();
    // The raw token is never stored.
    const { accessTokens } = await import("@lemonlime/db");
    const [stored] = await db.select().from(accessTokens);
    expect(stored!.tokenHash).toBe(hashAccessToken(raw));
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(stored!.lastUsedAt).not.toBeNull();
  });
});

describe("the secret that signs sessions", () => {
  it("must be set as soon as the app is reachable from other computers", async () => {
    const { ctx } = await createTestApp();
    const without = (publicUrl: string | undefined) => ({ ...ctx, vars: { ...ctx.vars, BETTER_AUTH_SECRET: undefined, LEMONLIME_PUBLIC_URL: publicUrl } });
    for (const url of ["https://lemonlime.example.com", "http://192.168.1.20:3000", "not a url"]) {
      expect(() => createAuth(without(url)), url).toThrow("BETTER_AUTH_SECRET is not set");
    }
    expect(() => createAuth({ ...without("http://localhost:3000"), production: true })).toThrow("BETTER_AUTH_SECRET is not set");
    // Trying things out on this computer works without one.
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://app.localhost:3000", undefined]) {
      expect(() => createAuth(without(url)), String(url)).not.toThrow();
    }
  });
});

describe("GitHub sign-in", () => {
  it("never keeps the tokens GitHub hands over", async () => {
    const { ctx, db } = await createTestApp();
    const { userId } = await addUser(db, "gh@example.com");
    const auth = createAuth(ctx);
    const adapter = (await auth.$context).internalAdapter;
    const created = await adapter.createAccount({
      userId,
      providerId: "github",
      accountId: "12345",
      accessToken: "gho_secret",
      refreshToken: "ghr_secret",
      idToken: "id_secret",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: "read:user,user:email",
    });
    await adapter.updateAccount(created.id, { accessToken: "gho_again", refreshToken: "ghr_again" });
    const [row] = await db.select().from(account).where(eq(account.userId, userId));
    expect(row).toMatchObject({ providerId: "github", accountId: "12345", accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null });
    expect(JSON.stringify(row)).not.toMatch(/secret|again/);
  });
});
