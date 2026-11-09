import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentCredentials, secrets } from "@lemonlime/db";
import { AgentCredentialUpload } from "@lemonlime/protocol";
import { decryptSecret, deleteSecret, encryptSecret, listSecrets, setSecret, validateSecretName } from "../src/lib/secrets.ts";
import { saveAgentCredential } from "../src/lib/agent-credentials.ts";
import { createThread, resumeThread, pauseThread } from "../src/lib/threads.ts";
import { addUser, createTestApp } from "./helpers.ts";

describe("secrets", () => {
  it("encrypts with the workspace and name bound in, so values can't be moved", async () => {
    const { ctx } = await createTestApp();
    const sealed = await encryptSecret(ctx, "ws-1", "NPM_TOKEN", "npm_live_value");
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("npm_live_value");
    expect(await decryptSecret(ctx, "ws-1", "NPM_TOKEN", sealed)).toBe("npm_live_value");
    await expect(decryptSecret(ctx, "ws-1", "OTHER", sealed)).rejects.toThrow();
    await expect(decryptSecret(ctx, "ws-2", "NPM_TOKEN", sealed)).rejects.toThrow();
    // Same value twice gives different ciphertext (fresh IV).
    expect(await encryptSecret(ctx, "ws-1", "NPM_TOKEN", "npm_live_value")).not.toBe(sealed);
  });

  it("validates names and never lists values", async () => {
    expect(validateSecretName("NPM_TOKEN")).toBeNull();
    expect(validateSecretName("npm_token")).toMatch(/capital letters/);
    expect(validateSecretName("LEMONLIME_X")).toMatch(/LemonLime itself/);
    expect(validateSecretName("PATH")).toMatch(/set by the sandbox/);

    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    await setSecret(ctx, alice.userId, alice.workspaceId, "NPM_TOKEN", "first");
    await setSecret(ctx, alice.userId, alice.workspaceId, "NPM_TOKEN", "second");
    const listed = await listSecrets(ctx, alice.workspaceId);
    expect(listed.map(s => s.name)).toEqual(["NPM_TOKEN"]);
    expect(JSON.stringify(listed)).not.toContain("second");
    const [row] = await db.select().from(secrets).where(eq(secrets.workspaceId, alice.workspaceId));
    expect(row!.ciphertext).not.toContain("second");
    await expect(setSecret(ctx, alice.userId, alice.workspaceId, "bad name", "x")).rejects.toMatchObject({ status: 400 });
    expect(await deleteSecret(ctx, alice.userId, alice.workspaceId, "NPM_TOKEN")).toBe(true);
    expect(await deleteSecret(ctx, alice.userId, alice.workspaceId, "NPM_TOKEN")).toBe(false);
  });

  it("are given to new sandboxes, marked for redaction, and never to other workspaces", async () => {
    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const bob = await addUser(db, "bob@example.com");
    await setSecret(ctx, alice.userId, alice.workspaceId, "NPM_TOKEN", "npm_secret_value");
    await setSecret(ctx, alice.userId, alice.workspaceId, "DEPLOY_KEY", "deploy_secret_value");
    const req = {
      agent: { kind: "codex" as const },
      repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
      mode: "cloud" as const,
      sandboxSize: "small" as const,
    };
    const t = await createThread(ctx, alice.userId, alice.workspaceId, req);
    const env = sandbox.created[0]!.runner.env;
    expect(env).toMatchObject({ NPM_TOKEN: "npm_secret_value", DEPLOY_KEY: "deploy_secret_value", LEMONLIME_REDACT_ENV: "DEPLOY_KEY,NPM_TOKEN" });
    expect(env.LEMONLIME_THREAD_SECRET).toBeTruthy();

    await createThread(ctx, bob.userId, bob.workspaceId, req);
    expect(sandbox.created[1]!.runner.env.NPM_TOKEN).toBeUndefined();
    expect(sandbox.created[1]!.runner.env.LEMONLIME_REDACT_ENV).toBeUndefined();

    // Resuming doesn't re-send them; the sandbox kept its environment.
    await pauseThread(ctx, alice.userId, t.thread.id);
    await resumeThread(ctx, alice.userId, t.thread.id);
    expect(sandbox.created).toHaveLength(2);
  });

  it("give a user's saved agent sign-in to their next sandboxes only", async () => {
    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const bob = await addUser(db, "bob@example.com");
    await saveAgentCredential(ctx, alice.userId, {
      agent: "claude-code",
      kind: "env",
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-alice-token-value",
    });
    await saveAgentCredential(ctx, alice.userId, {
      agent: "codex",
      kind: "file",
      name: ".codex/auth.json",
      value: '{"tokens":{"access_token":"alice-codex"}}',
    });
    const req = (kind: "claude-code" | "codex") => ({
      agent: { kind },
      repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
      mode: "cloud" as const,
      sandboxSize: "small" as const,
    });

    await createThread(ctx, alice.userId, alice.workspaceId, req("claude-code"));
    expect(sandbox.created[0]!.runner.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-alice-token-value",
      LEMONLIME_REDACT_ENV: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(sandbox.created[0]!.runner.env.LEMONLIME_AGENT_FILES).toBeUndefined();

    await createThread(ctx, alice.userId, alice.workspaceId, req("codex"));
    const files = JSON.parse(Buffer.from(sandbox.created[1]!.runner.env.LEMONLIME_AGENT_FILES!, "base64").toString());
    expect(files).toEqual({ ".codex/auth.json": '{"tokens":{"access_token":"alice-codex"}}' });
    expect(sandbox.created[1]!.runner.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    await createThread(ctx, bob.userId, bob.workspaceId, req("claude-code"));
    expect(sandbox.created[2]!.runner.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("only keep the credential each agent really uses", async () => {
    const upload = (agent: string, kind: string, name: string) =>
      AgentCredentialUpload.safeParse({ threadId: "thread-cred-1", agent, kind, name, value: "x" }).success;
    expect(upload("claude-code", "env", "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(upload("codex", "file", ".codex/auth.json")).toBe(true);
    // Code in a sandbox can call the upload route; these would follow the user into every sandbox.
    expect(upload("claude-code", "env", "NODE_OPTIONS")).toBe(false);
    expect(upload("codex", "env", "GIT_CONFIG_COUNT")).toBe(false);
    expect(upload("codex", "file", ".bashrc")).toBe(false);
    expect(upload("opencode", "env", "OPENAI_API_KEY")).toBe(false);

    const { ctx, db, sandbox } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    await expect(saveAgentCredential(ctx, alice.userId, { agent: "claude-code", kind: "env", name: "BASH_ENV", value: "/tmp/x" })).rejects.toThrow();
    // A row that got in some other way is still never handed to a sandbox.
    await db.insert(agentCredentials).values({ userId: alice.userId, agent: "claude-code", kind: "env", name: "BASH_ENV", ciphertext: "junk" });
    await createThread(ctx, alice.userId, alice.workspaceId, {
      agent: { kind: "claude-code" },
      repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
      mode: "cloud",
      sandboxSize: "small",
    });
    expect(sandbox.created[0]!.runner.env.BASH_ENV).toBeUndefined();
  });
});

describe("saved agent sign-ins", () => {
  it("are only accepted soon after a member asked to sign in", async () => {
    const { signInRequestedRecently, SIGN_IN_WINDOW_MS } = await import("../src/lib/agent-credentials.ts");
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect(signInRequestedRecently(null, now)).toBe(false);
    expect(signInRequestedRecently("not a date", now)).toBe(false);
    expect(signInRequestedRecently(new Date(now - 60_000).toISOString(), now)).toBe(true);
    expect(signInRequestedRecently(new Date(now - SIGN_IN_WINDOW_MS - 1).toISOString(), now)).toBe(false);
    // A time in the future (a clock far off, or a forged value) doesn't count.
    expect(signInRequestedRecently(new Date(now + 10 * 60_000).toISOString(), now)).toBe(false);
  });
});
