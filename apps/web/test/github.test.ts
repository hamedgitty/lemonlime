import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appJwt,
  githubAppConfig,
  linkInstallation,
  openPullRequest,
  parseGitHubRepo,
  signInstallState,
  tokenForThread,
  verifyInstallState,
} from "../src/lib/github.ts";
import { createThread, getThreadRow } from "../src/lib/threads.ts";
import { addUser, createTestApp, TEST_ENV } from "./helpers.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const VARS = {
  ...TEST_ENV,
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "lemonlime-test",
  GITHUB_APP_PRIVATE_KEY: PKCS1.replace(/\n/g, "\\n"), // as it often arrives in env vars
  GITHUB_APP_CLIENT_ID: "Iv1.test",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
};

afterEach(() => vi.restoreAllMocks());

/** Answer GitHub API calls from a table of "METHOD path" → [status, body]. */
function fakeGitHub(routes: Record<string, [number, unknown]>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push(key);
    const hit = routes[key] ?? [404, { message: "Not Found" }];
    return new Response(JSON.stringify(hit[1]), { status: hit[0], headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("GitHub app", () => {
  it("reads repository URLs in their usual shapes", () => {
    for (const url of [
      "https://github.com/acme/app",
      "https://github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "https://token@github.com/acme/app.git",
    ]) {
      expect(parseGitHubRepo(url), url).toEqual({ owner: "acme", repo: "app" });
    }
    expect(parseGitHubRepo("https://gitlab.com/acme/app.git")).toBeNull();
    expect(parseGitHubRepo("https://github.com/acme")).toBeNull();
  });

  it("signs its JWT with the app's PKCS#1 key", async () => {
    const cfg = githubAppConfig(VARS)!;
    const jwt = await appJwt(cfg, 1_800_000_000);
    const [head, body, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "12345" });
    const ok = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });

  it("ties the install round trip to who started it, briefly", async () => {
    const state = await signInstallState("secret", "ws-1", "user-1", 1000);
    expect(await verifyInstallState("secret", state, 1100)).toEqual({ workspaceId: "ws-1", userId: "user-1" });
    expect(await verifyInstallState("secret", state, 1000 + 601)).toBeNull();
    expect(await verifyInstallState("other-secret", state, 1100)).toBeNull();
    const [payload, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ w: "ws-2", u: "user-1", exp: 9e9 })).toString("base64url");
    expect(await verifyInstallState("secret", `${forged}.${sig}`, 1100)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("only links installations the person can manage, to one workspace", async () => {
    const { ctx, db } = await createTestApp();
    const cfg = githubAppConfig(VARS)!;
    const alice = await addUser(db, "alice@example.com");
    const bob = await addUser(db, "bob@example.com");
    fakeGitHub({
      "POST /login/oauth/access_token": [200, { access_token: "ghu_user" }],
      "GET /user/installations?per_page=100": [200, { installations: [{ id: 777, account: { login: "acme" } }] }],
    });
    await expect(linkInstallation(ctx, cfg, { workspaceId: alice.workspaceId, userId: alice.userId, installationId: "999", code: "c" })).rejects.toMatchObject({
      status: 403,
    });
    expect(await linkInstallation(ctx, cfg, { workspaceId: alice.workspaceId, userId: alice.userId, installationId: "777", code: "c" })).toEqual({
      accountLogin: "acme",
    });
    await expect(linkInstallation(ctx, cfg, { workspaceId: bob.workspaceId, userId: bob.userId, installationId: "777", code: "c" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("mints repo-scoped tokens only for the workspace that linked the repo, and opens pull requests", async () => {
    const app = await createTestApp();
    const ctx = { ...app.ctx, vars: { ...app.ctx.vars, ...VARS } };
    const cfg = githubAppConfig(VARS)!;
    const alice = await addUser(app.db, "alice@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    const req = {
      agent: { kind: "codex" as const },
      repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
      mode: "cloud" as const,
      sandboxSize: "small" as const,
    };
    const aliceThread = (await createThread(ctx, alice.userId, alice.workspaceId, req)).thread.id;
    const bobThread = (await createThread(ctx, bob.userId, bob.workspaceId, req)).thread.id;

    const calls = fakeGitHub({
      "POST /login/oauth/access_token": [200, { access_token: "ghu_user" }],
      "GET /user/installations?per_page=100": [200, { installations: [{ id: 777, account: { login: "acme" } }] }],
      "GET /repos/acme/app/installation": [200, { id: 777 }],
      "POST /app/installations/777/access_tokens": [201, { token: "ghs_repo", expires_at: "2026-01-01T01:00:00Z" }],
      "POST /repos/acme/app/pulls": [422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:agent/x." }] }],
    });
    await linkInstallation(ctx, cfg, { workspaceId: alice.workspaceId, userId: alice.userId, installationId: "777", code: "c" });

    const aliceRow = (await getThreadRow(ctx, aliceThread))!;
    expect(await tokenForThread(ctx, aliceRow)).toEqual({ token: "ghs_repo", expiresAt: "2026-01-01T01:00:00Z" });
    expect(await tokenForThread(ctx, (await getThreadRow(ctx, bobThread))!)).toBeNull();
    expect(calls).toContain("POST /app/installations/777/access_tokens");

    // An open pull request for the branch already exists: return it instead of failing.
    vi.restoreAllMocks();
    fakeGitHub({
      "GET /repos/acme/app/installation": [200, { id: 777 }],
      "POST /app/installations/777/access_tokens": [201, { token: "ghs_repo" }],
      "POST /repos/acme/app/pulls": [422, { message: "Validation Failed" }],
      [`GET /repos/acme/app/pulls?state=open&head=${encodeURIComponent(`acme:${aliceRow.branch}`)}`]: [
        200,
        [{ html_url: "https://github.com/acme/app/pull/7" }],
      ],
    });
    expect(await openPullRequest(ctx, aliceRow)).toEqual({ url: "https://github.com/acme/app/pull/7", created: false });
    expect((await getThreadRow(ctx, aliceThread))!.pullRequestUrl).toBe("https://github.com/acme/app/pull/7");
  });
});
