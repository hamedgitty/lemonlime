import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sandboxRuns, threads, workspaceMembers, workspaces } from "@lemonlime/db";
import { IDLE_PAUSE_AFTER_MS, type CreateThreadRequest } from "@lemonlime/protocol";
import { userWorkspaceIds } from "../src/lib/access.ts";
import { generateAccessToken, hashAccessToken } from "../src/lib/access-tokens.ts";
import { createAccessTokenRow, findUserByTokenHash } from "../src/lib/access.ts";
import { createAuth } from "../src/lib/better-auth.ts";
import { HttpError } from "../src/lib/errors.ts";
import {
  createThread,
  deleteThread,
  getThreadRowForUser,
  listThreads,
  pauseThread,
  recordHeartbeat,
  resumeThread,
  sweepRunningSandboxes,
} from "../src/lib/threads.ts";
import { addUser, createTestApp } from "./helpers.ts";

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
    const session = await auth.api.getSession({ headers: new Headers({ cookie: `better-auth.session_token=${await signedCookie(ctx.vars.BETTER_AUTH_SECRET!, result.token)}` }) });
    expect(session?.user.id).toBe(result.user.id);

    // Signing in again does not create a second workspace.
    await auth.api.sendVerificationOTP({ body: { email: "new@example.com", type: "sign-in" } });
    const code2 = /\b(\d{6})\b/.exec(emails[1]!.text)?.[1]!;
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

    const closed = await deleteThread(ctx, alice.userId, created.thread.id);
    expect(closed.thread.status).toBe("stopped");
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

    // Heartbeats update status; once idle long enough the sweep pauses it, exactly once.
    const idleSince = new Date(Date.now() - IDLE_PAUSE_AFTER_MS - 1000).toISOString();
    expect(await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 7, idleSince, runnerVersion: "test" })).toEqual({
      action: "none",
    });
    const sweep = await sweepRunningSandboxes(ctx);
    expect(sweep).toEqual({ checked: 1, paused: [{ threadId: id, endReason: "idle" }], errors: [] });
    expect(await sweepRunningSandboxes(ctx)).toEqual({ checked: 0, paused: [], errors: [] });
    expect((await db.select().from(sandboxRuns).where(eq(sandboxRuns.threadId, id))).map(r => r.endReason)).toEqual(["user", "idle"]);

    // A runner that keeps reporting after the pause is asked to shut down.
    expect(await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 9, idleSince, runnerVersion: "test" })).toEqual({
      action: "shutdown",
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
