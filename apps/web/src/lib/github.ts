import { and, eq } from "drizzle-orm";
import { githubInstallations, threads, type ThreadRow } from "@lemonlime/db";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";

/**
 * GitHub App integration: people install the app on the repositories they choose, and
 * sandboxes get short-lived tokens scoped to their thread's repository to clone, push the
 * thread branch, and open pull requests. Nothing long-lived ever reaches a sandbox.
 *
 * Settings: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY (PEM), and the app's
 * GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET (used to check who installed it).
 */
export interface GitHubAppConfig {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  webUrl: string;
}

export function githubAppConfig(vars: Record<string, string | undefined>): GitHubAppConfig | null {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET } = vars;
  if (!GITHUB_APP_ID || !GITHUB_APP_SLUG || !GITHUB_APP_PRIVATE_KEY || !GITHUB_APP_CLIENT_ID || !GITHUB_APP_CLIENT_SECRET) return null;
  return {
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    // Env vars often carry the PEM with literal "\n".
    privateKey: GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    clientId: GITHUB_APP_CLIENT_ID,
    clientSecret: GITHUB_APP_CLIENT_SECRET,
    apiUrl: (vars.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
    webUrl: (vars.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, ""),
  };
}

export function requireGitHub(ctx: AppContext): GitHubAppConfig {
  const cfg = githubAppConfig(ctx.vars);
  if (!cfg) throw new HttpError(501, "GitHub isn't set up on this control plane. See docs/self-hosting.md (GitHub App).");
  return cfg;
}

// ─── Repository URLs ────────────────────────────────────────────────────────

/** owner/repo from an https or ssh GitHub URL, or null for anything else. */
export function parseGitHubRepo(url: string, webHost = "github.com"): { owner: string; repo: string } | null {
  const host = webHost
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\./g, "\\.");
  const m = new RegExp(`^(?:https://(?:[^@/]+@)?${host}/|git@${host}:|ssh://git@${host}/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?$`).exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

// ─── Signing ────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

function pemBody(pem: string): { der: Uint8Array<ArrayBuffer>; pkcs1: boolean } {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return { der: Uint8Array.from(atob(body), c => c.charCodeAt(0)), pkcs1 };
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub hands out keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto only imports
 * PKCS#8. Wrap it: SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING { key } }.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

const appKeys = new Map<string, Promise<CryptoKey>>();

function appKey(pem: string): Promise<CryptoKey> {
  let key = appKeys.get(pem);
  if (!key) {
    const { der, pkcs1 } = pemBody(pem);
    const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
    key = crypto.subtle.importKey("pkcs8", new Uint8Array(pkcs8).buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    appKeys.set(pem, key);
  }
  return key;
}

/** The app's own JWT (RS256, 9 minutes; GitHub allows 10). Back-dated a minute for clock drift. */
export async function appJwt(cfg: GitHubAppConfig, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64urlText(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: cfg.appId }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await appKey(cfg.privateKey), new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`github-install:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Ties an install round trip to the workspace and person who started it (10 minutes). */
export async function signInstallState(secret: string, workspaceId: string, userId: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = b64urlText(JSON.stringify({ w: workspaceId, u: userId, exp: nowSec + 600 }));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifyInstallState(
  secret: string,
  state: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ workspaceId: string; userId: string } | null> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), raw, new TextEncoder().encode(payload)))) return null;
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { w: string; u: string; exp: number };
  return claims.exp > nowSec ? { workspaceId: claims.w, userId: claims.u } : null;
}

// ─── GitHub API ─────────────────────────────────────────────────────────────

async function gh<T>(cfg: GitHubAppConfig, path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: auth,
      "x-github-api-version": "2022-11-28",
      "user-agent": "LemonLime",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

export function installUrl(cfg: GitHubAppConfig, state: string): string {
  return `${cfg.webUrl}/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * Link an installation to a workspace, but only if the person who came back from GitHub
 * can really see it: GitHub's redirect carries an installation id anyone could change,
 * so we exchange the OAuth `code` for their token and look the id up in their own list.
 */
export async function linkInstallation(
  ctx: AppContext,
  cfg: GitHubAppConfig,
  opts: { workspaceId: string; userId: string; installationId: string; code: string },
): Promise<{ accountLogin: string }> {
  const tokenRes = await fetch(`${cfg.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "LemonLime" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code: opts.code }),
  });
  const { access_token: userToken } = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!userToken) throw new HttpError(400, "GitHub didn't confirm who you are. Try connecting again.");
  const mine = await gh<{ installations?: { id: number; account?: { login?: string } }[] }>(cfg, "/user/installations?per_page=100", `Bearer ${userToken}`);
  const found = mine.data.installations?.find(i => String(i.id) === opts.installationId);
  if (!found) throw new HttpError(403, "That GitHub installation isn't one you can manage.");
  const accountLogin = found.account?.login ?? "unknown";
  const [existing] = await ctx.db.select().from(githubInstallations).where(eq(githubInstallations.id, opts.installationId));
  if (existing && existing.workspaceId !== opts.workspaceId) throw new HttpError(409, "That GitHub installation is already connected to another workspace.");
  await ctx.db
    .insert(githubInstallations)
    .values({ id: opts.installationId, workspaceId: opts.workspaceId, accountLogin, linkedBy: opts.userId })
    .onConflictDoUpdate({ target: githubInstallations.id, set: { accountLogin } });
  return { accountLogin };
}

export async function listInstallations(ctx: AppContext, workspaceId: string): Promise<{ id: string; accountLogin: string }[]> {
  return ctx.db
    .select({ id: githubInstallations.id, accountLogin: githubInstallations.accountLogin })
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId));
}

export async function unlinkInstallation(ctx: AppContext, workspaceId: string, installationId: string): Promise<void> {
  await ctx.db.delete(githubInstallations).where(and(eq(githubInstallations.id, installationId), eq(githubInstallations.workspaceId, workspaceId)));
}

/**
 * A token for one thread's repository, valid for an hour: read and write code, open pull
 * requests. Null when the repo isn't on GitHub or the workspace hasn't installed the app
 * on it (public repos then still clone without one).
 */
export async function tokenForThread(ctx: AppContext, row: Pick<ThreadRow, "workspaceId" | "repo">): Promise<{ token: string; expiresAt: string } | null> {
  const cfg = githubAppConfig(ctx.vars);
  if (!cfg) return null;
  const repo = parseGitHubRepo(row.repo.url, cfg.webUrl);
  if (!repo) return null;
  const jwt = `Bearer ${await appJwt(cfg)}`;
  const inst = await gh<{ id?: number }>(cfg, `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/installation`, jwt);
  if (inst.status !== 200 || !inst.data.id) return null;
  const linked = await ctx.db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.id, String(inst.data.id)), eq(githubInstallations.workspaceId, row.workspaceId)));
  if (linked.length === 0) return null; // installed, but not by this workspace
  const minted = await gh<{ token?: string; expires_at?: string }>(cfg, `/app/installations/${inst.data.id}/access_tokens`, jwt, {
    method: "POST",
    body: { repositories: [repo.repo], permissions: { contents: "write", pull_requests: "write" } },
  });
  if (minted.status !== 201 || !minted.data.token) throw new HttpError(502, `GitHub didn't issue a token (HTTP ${minted.status}).`);
  return { token: minted.data.token, expiresAt: minted.data.expires_at ?? new Date(Date.now() + 3600_000).toISOString() };
}

/** Open (or find) the pull request for a thread's branch and remember its link. */
export async function openPullRequest(
  ctx: AppContext,
  row: ThreadRow,
  opts: { title?: string; body?: string } = {},
): Promise<{ url: string; created: boolean }> {
  const cfg = requireGitHub(ctx);
  const repo = parseGitHubRepo(row.repo.url, cfg.webUrl);
  if (!repo) throw new HttpError(400, "Pull requests need a GitHub repository.");
  const creds = await tokenForThread(ctx, row);
  if (!creds) throw new HttpError(409, `Install the LemonLime GitHub app on ${repo.owner}/${repo.repo} first (Settings → GitHub).`);
  const auth = `Bearer ${creds.token}`;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const title = (opts.title || row.title || `Changes from LemonLime thread ${row.id}`).slice(0, 200);
  const body = opts.body ?? `Opened from LemonLime thread \`${row.id}\`. The agent's work is on \`${row.branch}\`.`;
  const created = await gh<{ html_url?: string; errors?: { message?: string }[]; message?: string }>(cfg, `${base}/pulls`, auth, {
    method: "POST",
    body: { title, head: row.branch, base: row.repo.baseBranch, body },
  });
  let url = created.data.html_url;
  let isNew = created.status === 201;
  if (!url && created.status === 422) {
    // Already open? Then return that one.
    const open = await gh<{ html_url?: string }[]>(cfg, `${base}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${row.branch}`)}`, auth);
    url = Array.isArray(open.data) ? open.data[0]?.html_url : undefined;
    isNew = false;
    if (!url) {
      const why = created.data.errors?.[0]?.message ?? created.data.message ?? "GitHub refused it";
      throw new HttpError(422, `Couldn't open a pull request: ${why}. Has the agent pushed any commits yet?`);
    }
  }
  if (!url) throw new HttpError(502, `GitHub didn't open the pull request (HTTP ${created.status}).`);
  await ctx.db.update(threads).set({ pullRequestUrl: url }).where(eq(threads.id, row.id));
  return { url, created: isNew };
}
