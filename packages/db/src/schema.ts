import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentConfig, RepoRef, SandboxSize, ThreadMode, ThreadStatus } from "@lemonlime/protocol";

/**
 * LemonLime control plane schema (SQLite: Cloudflare D1 or a local SQLite file).
 *
 * There is no row-level security in SQLite. The web app checks workspace
 * membership itself before every read or write (`apps/web/src/lib/access.ts`).
 *
 * App tables store times as ISO 8601 strings (`new Date().toISOString()`), which
 * sort correctly as text. The Better Auth tables use its own layout (epoch ms).
 */

const nowIso = () => new Date().toISOString();
const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

// ─── Better Auth ─────────────────────────────────────────────────────────────
// Matches the Drizzle schema the Better Auth CLI generates for SQLite.

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(nowMs)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  t => [index("session_user_id_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  t => [index("account_user_id_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(nowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  t => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Request counters for rate limiting, shared by every Worker isolate (an in-memory
 * counter would only see one isolate's traffic). Better Auth uses it for its own routes;
 * `apps/web/src/lib/rate-limit.ts` uses it, with keys starting "app:", for the rest.
 */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  /** Start of the current window, epoch milliseconds. */
  lastRequest: integer("last_request").notNull(),
});

// ─── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    personal: integer("personal", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  t => [check("workspaces_name_length", sql`length(${t.name}) between 1 and 200`)],
);

export type WorkspaceRole = "owner" | "member";

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  t => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_idx").on(t.userId),
    check("workspace_members_role", sql`${t.role} in ('owner', 'member')`),
  ],
);

// ─── Threads ─────────────────────────────────────────────────────────────────

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    agent: text("agent", { mode: "json" }).$type<AgentConfig>().notNull(),
    repo: text("repo", { mode: "json" }).$type<RepoRef>().notNull(),
    branch: text("branch").notNull(),
    mode: text("mode").$type<ThreadMode>().notNull(),
    status: text("status").$type<ThreadStatus>().notNull(),
    sandboxSize: text("sandbox_size").$type<SandboxSize>().notNull().default("small"),
    sandboxProvider: text("sandbox_provider"),
    sandboxId: text("sandbox_id"),
    runnerUrl: text("runner_url"),
    latestSeq: integer("latest_seq").notNull().default(0),
    /** When the agent last finished work (from heartbeats); null while it works. */
    idleSince: text("idle_since"),
    /** Start of the current stretch of sandbox running time; null when not running. */
    runningSince: text("running_since"),
    lastHeartbeatAt: text("last_heartbeat_at"),
    /** First message, sent by the first client that connects to a fresh runner. */
    initialPrompt: text("initial_prompt"),
    /** Highest event seq kept in history storage (survives the sandbox). */
    historySeq: integer("history_seq").notNull().default(0),
    /** Background work the runner last reported (build, download, server), or null. */
    background: text("background"),
    /** When the sweep asked the runner to drain before a pause; null otherwise. */
    drainRequestedAt: text("drain_requested_at"),
    /** When the runner said it had drained. */
    drainedAt: text("drained_at"),
    /** Pull request opened for the thread's branch, if any. */
    pullRequestUrl: text("pull_request_url"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso).$onUpdate(nowIso),
  },
  t => [
    index("threads_workspace_updated_idx").on(t.workspaceId, t.updatedAt),
    index("threads_running_idx").on(t.runningSince),
    check("threads_title_length", sql`length(${t.title}) <= 200`),
    check("threads_mode", sql`${t.mode} in ('local', 'cloud')`),
    check("threads_status", sql`${t.status} in ('provisioning', 'idle', 'running', 'paused', 'stopped', 'failed')`),
    check("threads_sandbox_size", sql`${t.sandboxSize} in ('small', 'large')`),
    check("threads_latest_seq", sql`${t.latestSeq} >= 0`),
  ],
);

// ─── Sandbox runs (neutral audit log of running time) ───────────────────────

export type EndReason = "idle" | "user" | "policy" | "error" | "replaced";

export const sandboxRuns = sqliteTable(
  "sandbox_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sandboxId: text("sandbox_id").notNull(),
    size: text("size").$type<SandboxSize>().notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    runtimeSeconds: integer("runtime_seconds").notNull(),
    endReason: text("end_reason").$type<EndReason>().notNull(),
  },
  t => [
    index("sandbox_runs_thread_idx").on(t.threadId, t.startedAt),
    index("sandbox_runs_workspace_idx").on(t.workspaceId, t.startedAt),
    check("sandbox_runs_size", sql`${t.size} in ('small', 'large')`),
    check("sandbox_runs_runtime", sql`${t.runtimeSeconds} >= 0`),
    check("sandbox_runs_end_reason", sql`${t.endReason} in ('idle', 'user', 'policy', 'error', 'replaced')`),
  ],
);

// ─── GitHub App installations linked to a workspace ──────────────────────────

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    /** GitHub's installation id. */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The user or organization the app is installed on. */
    accountLogin: text("account_login").notNull(),
    linkedBy: text("linked_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  t => [index("github_installations_workspace_idx").on(t.workspaceId)],
);

// ─── Secrets (environment variables for cloud sandboxes) ─────────────────────

export const secrets = sqliteTable(
  "secrets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Environment variable name, e.g. NPM_TOKEN. */
    name: text("name").notNull(),
    /** AES-256-GCM, "v1:" + base64(iv + ciphertext + tag). Never returned by the API. */
    ciphertext: text("ciphertext").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso).$onUpdate(nowIso),
  },
  t => [uniqueIndex("secrets_workspace_name_idx").on(t.workspaceId, t.name)],
);

// ─── Messages sent while a sandbox was paused ────────────────────────────────

export const pendingMessages = sqliteTable(
  "pending_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    clientMsgId: text("client_msg_id").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  t => [uniqueIndex("pending_messages_thread_msg_idx").on(t.threadId, t.clientMsgId)],
);

// ─── Personal access tokens (desktop app) ────────────────────────────────────

export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the raw token, hex. The raw token is shown once and never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    lastUsedAt: text("last_used_at"),
  },
  t => [
    uniqueIndex("access_tokens_token_hash_idx").on(t.tokenHash),
    index("access_tokens_user_idx").on(t.userId, t.createdAt),
    check("access_tokens_name_length", sql`length(${t.name}) between 1 and 100`),
  ],
);

export type UserRow = typeof user.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type NewThreadRow = typeof threads.$inferInsert;
export type SandboxRunRow = typeof sandboxRuns.$inferSelect;
export type AccessTokenRow = typeof accessTokens.$inferSelect;
