import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentConfig, ComputerPlatform, LocalThreadSnapshot, RepoRef, SandboxSize, ThreadMode, ThreadStatus, UserSkill } from "@lemonlime/protocol";

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

/**
 * An email invitation to join a workspace. Only a hash of the token is stored; the link
 * in the email is the only copy. Accepted invites are kept (accepted_at) for the record.
 */
export const workspaceInvites = sqliteTable(
  "workspace_invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Lower-cased; only someone signed in with this address can accept. */
    email: text("email").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
  },
  t => [
    uniqueIndex("workspace_invites_token_idx").on(t.tokenHash),
    index("workspace_invites_workspace_idx").on(t.workspaceId),
    check("workspace_invites_role", sql`${t.role} in ('owner', 'member')`),
  ],
);

export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect;

// ─── Threads ─────────────────────────────────────────────────────────────────

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** The person who started it lets the rest of the workspace direct its agent and reach its sandbox. */
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
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
    /** When a member last asked to sign the agent in; a saved sign-in is only accepted soon after. */
    signInRequestedAt: text("sign_in_requested_at"),
    /** CPU in use in the sandbox at the last heartbeat (cores), and the busiest program. */
    cpuCores: real("cpu_cores"),
    topProcess: text("top_process"),
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

// ─── Agent sign-ins kept for a user's next sandboxes ─────────────────────────

export const agentCredentials = sqliteTable(
  "agent_credentials",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    /** "env": an environment variable; "file": a file under the agent user's home. */
    kind: text("kind").$type<"env" | "file">().notNull(),
    name: text("name").notNull(),
    /** Encrypted like workspace secrets; never returned by the API. */
    ciphertext: text("ciphertext").notNull(),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso).$onUpdate(nowIso),
  },
  t => [uniqueIndex("agent_credentials_user_agent_name_idx").on(t.userId, t.agent, t.name)],
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
    /** A check script the runner runs before sending the message (automations); null for none. */
    check: text("check"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
  },
  t => [uniqueIndex("pending_messages_thread_msg_idx").on(t.threadId, t.clientMsgId)],
);

// ─── Health ──────────────────────────────────────────────────────────────────

/** Small facts for /api/health, e.g. when the idle sweep last ran. */
export const systemStatus = sqliteTable("system_status", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
});

// ─── Automations ─────────────────────────────────────────────────────────────

/** A prompt run as a new cloud thread on a schedule (the minute sweep starts due ones), or when its webhook is called. */
export const automations = sqliteTable(
  "automations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** Five-field cron, e.g. "0 9 * * 1-5"; empty when it only runs from its webhook. */
    schedule: text("schedule").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    agent: text("agent", { mode: "json" }).$type<AgentConfig>().notNull(),
    repo: text("repo", { mode: "json" }).$type<RepoRef>().notNull(),
    sandboxSize: text("sandbox_size").$type<SandboxSize>().notNull().default("small"),
    prompt: text("prompt").notNull(),
    /** Shell command run in the sandbox first; the run goes ahead only if it exits 0 and prints something. */
    checkScript: text("check_script").notNull().default(""),
    /** The workspace secrets its runs are given, by name; null gives them every one. */
    secretNames: text("secret_names", { mode: "json" }).$type<string[]>(),
    /** SHA-256 (hex) of the secret in its webhook URL; null when it has no webhook. */
    webhookTokenHash: text("webhook_token_hash"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Why it turned itself off (failing in a row, agent not signed in); null when on or paused by hand. */
    pausedReason: text("paused_reason"),
    /** When it was last turned back on; earlier runs don't count towards pausing it again. */
    resumedAt: text("resumed_at"),
    /** When it runs next (ISO); null when disabled or the schedule never fires again. */
    nextRunAt: text("next_run_at"),
    lastRunAt: text("last_run_at"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso).$onUpdate(nowIso),
  },
  t => [index("automations_due_idx").on(t.enabled, t.nextRunAt), index("automations_workspace_idx").on(t.workspaceId)],
);

/** Each time an automation was due: started a thread, was skipped (plan limit), or failed. */
export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    scheduledFor: text("scheduled_for").notNull(),
    ranAt: text("ran_at").notNull().$defaultFn(nowIso),
    status: text("status").$type<"started" | "skipped" | "failed">().notNull(),
    /** What started it. */
    trigger: text("trigger").$type<"schedule" | "webhook">().notNull().default("schedule"),
    threadId: text("thread_id"),
    /** Why it was skipped or failed, in words for the user. */
    detail: text("detail"),
    /** When someone in the workspace marked the run as looked at; null until then. */
    reviewedAt: text("reviewed_at"),
  },
  t => [index("automation_runs_automation_idx").on(t.automationId, t.ranAt)],
);

// ─── Workspace settings for cloud threads ────────────────────────────────────

/**
 * What every new cloud sandbox in a workspace starts with. One row per workspace, created
 * the first time an owner saves; a workspace without one uses the defaults.
 */
export const workspaceSettings = sqliteTable("workspace_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Custom instructions added to every agent turn. */
  instructions: text("instructions").notNull().default(""),
  /** Shell script run once in each new sandbox before the runner starts. */
  setupScript: text("setup_script").notNull().default(""),
  stripCoauthors: integer("strip_coauthors", { mode: "boolean" }).notNull().default(false),
  /** Retry turns that hit a busy provider or a usage limit for up to this long; 0: off. */
  retryMaxWaitMinutes: integer("retry_max_wait_minutes").notNull().default(0),
  /** Close cloud threads idle this many days and delete their sandboxes; null: never. */
  autoDeleteDays: integer("auto_delete_days"),
  /** The workspace's own skills: [{ name, files: { path: content } }]. */
  skills: text("skills", { mode: "json" }).$type<UserSkill[]>().notNull().default([]),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: text("updated_at").notNull().$defaultFn(nowIso).$onUpdate(nowIso),
});

export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;

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

// ─── Computers (phone access to local threads) ──────────────────────────────

/**
 * A computer running the desktop app, registered by its owner when they turn on phone
 * access (docs/phone-access.md). Only its owner can see or reach it.
 */
/** Desktop sign-in links already used, so one link makes one token. Old rows are pruned. */
export const desktopApprovals = sqliteTable("desktop_approvals", {
  /** SHA-256 (hex) of the state the desktop app put in its link. */
  stateHash: text("state_hash").primaryKey(),
  createdAt: text("created_at").notNull().$defaultFn(nowIso),
});

export const computers = sqliteTable(
  "computers",
  {
    /** Chosen at random by the desktop app and kept on the computer. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The workspace the desktop app is signed in to; the owner must stay a member. */
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").$type<ComputerPlatform>().notNull().default("other"),
    phoneAccess: integer("phone_access", { mode: "boolean" }).notNull().default(false),
    /** The desktop app only talks to phones paired with it, over a channel sealed end to end. */
    sealed: integer("sealed", { mode: "boolean" }).notNull().default(false),
    /** Goes up each time phone access is turned off; tickets from before stop working. */
    epoch: integer("epoch").notNull().default(0),
    /** The local threads it shares while phone access is on; emptied when it's turned off. */
    threads: text("threads", { mode: "json" }).$type<LocalThreadSnapshot[]>().notNull().default([]),
    /** When the desktop app last checked in while phone access was on. */
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull().$defaultFn(nowIso),
    updatedAt: text("updated_at").notNull().$defaultFn(nowIso).$onUpdate(nowIso),
  },
  t => [
    index("computers_user_idx").on(t.userId),
    check("computers_name_length", sql`length(${t.name}) between 1 and 100`),
    check("computers_platform", sql`${t.platform} in ('mac', 'windows', 'linux', 'other')`),
  ],
);

export type ComputerRow = typeof computers.$inferSelect;

export type UserRow = typeof user.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type NewThreadRow = typeof threads.$inferInsert;
export type SandboxRunRow = typeof sandboxRuns.$inferSelect;
export type AccessTokenRow = typeof accessTokens.$inferSelect;
