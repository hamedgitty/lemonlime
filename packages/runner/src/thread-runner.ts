import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { installCoauthorHooks } from "./coauthors.ts";
import { withoutRewound, type NewEvent, type Preview, type QueuedMessage, type Thread, type ThreadEvent, type ThreadStatus } from "@lemonlime/protocol";
import { randomUUID } from "node:crypto";
import { detectVersion, TESTED_AGENTS, versionNotice, type AgentAdapter, type AgentSession, type SessionOptions } from "./agents/index.ts";
import { SideChats } from "./side-chats.ts";
import { Subagents } from "./subagents.ts";
import { ComputerBridge } from "./computer.ts";
import { exportThread, importThread, type ImportResult, type TeleportExport } from "./teleport.ts";
import { attachmentNote, Attachments, ATTACHMENTS_DIR, type Upload } from "./attachments.ts";
import { EventStore } from "./event-store.ts";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.ts";
import { commitSubject, GitWorkspace } from "./git.ts";
import { type AgentCredential, LoginSession, type LoginUpdate } from "./login.ts";
import { createRedactor } from "./redact.ts";
import { installSkills } from "./skills.ts";
import { installPluginsIntoThread, loadEnabledPlugins } from "./agent-plugins.ts";

export interface ThreadRunnerOptions {
  /** Shortest wait before continuing after a usage limit (default 5 s; tests use less). */
  limitMinWaitMs?: number;
  thread: Thread;
  workdir: string;
  /** Where history and state are kept. null keeps everything in memory (tests). */
  dataDir: string | null;
  adapter: AgentAdapter;
  session: Omit<SessionOptions, "cwd" | "saved">;
  /** Manage the thread's git branch and commit after each turn. Default true. */
  git?: boolean;
  /** Clone this repository into an empty workdir. */
  repoUrl?: string;
  /**
   * The user's own repository. When set, `workdir` becomes a separate git worktree of it,
   * so the thread never switches the user's branch or touches their uncommitted work.
   */
  sourceRepo?: string;
  /** Tell the user when the agent has printed nothing for this long. Default 15 minutes. */
  quietNoticeMs?: number;
  /** Stop a turn that runs longer than this. Default 4 hours. */
  turnTimeoutMs?: number;
  /** Check the agent CLI's version at start and note it if older than the tested one. */
  checkAgentVersion?: boolean;
  /** How long an approval request waits for the user before it is declined. Default 30 minutes. */
  approvalTimeoutMs?: number;
  /** Copy LemonLime's bundled skills into the thread. Default true. */
  bundledSkills?: boolean;
  /** More skill folders (each with a SKILL.md inside) to copy into the thread. */
  extraSkillDirs?: string[];
  /**
   * The user's agent plugins: a folder holding plugins.json and one folder per plugin
   * (see agent-plugins.ts). The enabled ones are put into the thread.
   */
  pluginsDir?: string;
  /** Secret values (by name) to keep out of every event. */
  redact?: Record<string, string>;
  /** Push the thread branch to origin after every turn that commits (cloud threads). */
  pushBranch?: boolean;
  /** git credential helper for clone/fetch/push (cloud threads; see git-credential.ts). */
  credentialHelper?: string;
  /** Keep a credential the user produced by signing the agent in (cloud threads upload it). */
  onAgentCredential?: (credential: AgentCredential) => Promise<void>;
  /** For tests: the command a sign-in runs instead of the agent's own. */
  loginCommand?: string[];
  /** Bundled skills to leave out, by name. */
  disabledSkills?: string[];
  /** Take Co-authored-by trailers out of the commits the agent makes (see coauthors.ts). */
  stripCoauthors?: boolean;
  /**
   * When a turn fails because the provider is overloaded or a usage limit was hit, wait and
   * run it again, waiting at most this long in all for one message. 0 or unset: off (a
   * usage limit then still continues the thread once it resets; see onUsageLimit).
   */
  retryMaxWaitMs?: number;
  /** Shortest wait before a retry (default 30 s; tests use less). */
  retryMinWaitMs?: number;
  /** Output of the sandbox's setup script, shown in the thread once (see SETUP_LOG in cli.ts). */
  setupLog?: string;
}

/** A turn waiting to be run again after the provider was busy or a limit was hit. */
interface PendingRetry {
  clientMsgId: string;
  /** The message as the agent first got it. */
  prompt: string;
  reason: "overloaded" | "usage_limit";
  /** Tries so far, including the first. */
  attempts: number;
  /** When the first try failed (ISO): the max wait counts from here. */
  firstFailedAt: string;
  /** When to try again (ISO). */
  at: string;
}

/** Most tries of one message, however short the waits. */
const MAX_RETRY_ATTEMPTS = 12;
/** Waits between tries when the provider didn't say: 30 s, 1, 2, 4, 8 minutes, then 15. */
const RETRY_BASE_MS = 30_000;
const RETRY_STEP_CAP_MS = 15 * 60_000;

/** What the agent is told when a message is sent again. */
export function retryPrompt(prompt: string, reason: PendingRetry["reason"]): string {
  const why = reason === "overloaded" ? "the AI provider was overloaded" : "the plan's usage limit was reached";
  return `(Sent again by LemonLime: your last try at this message stopped because ${why}. If you already did part of it, carry on from there.)\n\n${prompt}`;
}

function inWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60_000;

const DEFAULT_QUIET_MS = 15 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60_000;

/** How to fix the common agent problems, per agent, in words a user can act on. */
const SIGN_IN: Partial<Record<string, string>> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  opencode: "opencode auth login",
};
const UPDATE: Partial<Record<string, string>> = {
  "claude-code": "claude update",
  codex: "codex update",
  opencode: "opencode upgrade",
};

export function fixHint(code: string | undefined, agent: string): string | null {
  if (code === "auth_required") {
    const cmd = SIGN_IN[agent];
    return cmd ? `Sign the agent in by running \`${cmd}\` in a terminal, then send your message again.` : "Sign the agent in, then send your message again.";
  }
  if (code === "agent_outdated") {
    const cmd = UPDATE[agent];
    return cmd ? `Update the agent by running \`${cmd}\`, then send your message again.` : "Update the agent, then send your message again.";
  }
  return null;
}

/** @deprecated Messages sent while the agent is busy are queued now; this is never thrown. */
export class BusyError extends Error {
  constructor() {
    super("The agent is still working on the previous message. Interrupt it or wait.");
  }
}

/** What happened to a sent message. */
export interface SendResult {
  clientMsgId: string;
  result: "started" | "queued" | "duplicate";
}

interface SavedState {
  agentState: Record<string, string>;
  status: ThreadStatus;
  queue?: QueuedMessage[];
  /** The agent hit the user's plan limit; continue at `resetAt` (or after a while). */
  usageLimit?: { resetAt: string | null };
  /** When the runner continued a thread on its own after a limit (ISO), for the daily cap. */
  autoContinues?: string[];
  /**
   * Earlier conversation for the next turn's fresh agent conversation (after a rewind, a
   * move, or an import of history from outside LemonLime), kept until that turn starts.
   */
  recap?: string;
  /** A message waiting to be tried again (see --retry-max-wait). */
  retry?: PendingRetry;
}

/** What the runner says on the user's behalf when a usage limit lifts. */
export const CONTINUE_AFTER_LIMIT = "Continue where you left off. (Sent by LemonLime after your plan's usage limit reset.)";
/** Most automatic continues per thread in a day, so a stuck limit can't loop. */
const MAX_AUTO_CONTINUES_PER_DAY = 3;
/** When the agent didn't say when its limit lifts, try again after this long. */
const LIMIT_RETRY_MS = 30 * 60_000;
/** Never wait longer than this for one (weekly limits); the user can always send a message. */
const LIMIT_MAX_WAIT_MS = 7 * 24 * 3_600_000;

/** Commit subject for changes an interrupted turn left behind. */
const UNFINISHED_SUBJECT = "Unfinished changes from a turn the runner did not finish";

/** Owns one thread: its history, its agent session and its git branch. */
export class ThreadRunner {
  readonly store: EventStore;
  private session: AgentSession | null = null;
  private status: ThreadStatus;
  private idleSince: string | null = null;
  private abort: AbortController | null = null;
  private current: Promise<void> | null = null;
  private readonly git: GitWorkspace | null;
  private readonly statusListeners = new Set<(s: ThreadStatus) => void>();
  private queue: QueuedMessage[] = [];
  private initialised = false;
  /** Crashes in a row; the agent is restarted after the first and left alone after the second. */
  private crashes = 0;
  private agentState: Record<string, string> = {};
  /** Approval requests waiting for the user, by request id. */
  private readonly approvals = new Map<string, (decision: ApprovalDecision, by: "user" | "timeout" | "interrupted") => void>();

  /** How many approvals the agent is waiting on (for /healthz, so apps can notify). */
  get waitingApprovals(): number {
    return this.approvals.size;
  }
  /** Every clientMsgId this thread has accepted, so a resend never runs twice. */
  private readonly seen = new Set<string>();

  /** What every agent session in this thread starts with (the main one, subagents, side chats); plugins add MCP servers in init(). */
  private readonly sessionOpts: Omit<SessionOptions, "cwd" | "saved">;

  constructor(private readonly opts: ThreadRunnerOptions) {
    const hooksEnv =
      opts.stripCoauthors && opts.git !== false
        ? installCoauthorHooks(opts.dataDir ? join(opts.dataDir, "git-hooks") : mkdtempSync(join(tmpdir(), "lemonlime-hooks-")))
        : null;
    this.sessionOpts = hooksEnv ? { ...opts.session, env: { ...opts.session.env, ...hooksEnv } } : { ...opts.session };
    this.redactions = { ...opts.redact };
    this.store = new EventStore(opts.thread.id, opts.dataDir ? join(opts.dataDir, "events.jsonl") : null, createRedactor(this.redactions));
    this.status = opts.thread.status;
    this.git = opts.git === false ? null : new GitWorkspace(opts.workdir, opts.credentialHelper);
    this.attachments = new Attachments(opts.workdir);
    this.subagents = new Subagents({
      adapter: opts.adapter,
      session: this.sessionOpts,
      cwd: opts.workdir,
      toMain: (text, id) => {
        if (!this.closing) this.sendMessage(text, `subagent-${id}`);
      },
      notice: (code, message) => this.store.append({ type: "notice", code, message }),
    });
    const { autonomy: _a, ...session } = this.sessionOpts;
    this.side = new SideChats({
      threadId: opts.thread.id,
      adapter: opts.adapter,
      session,
      cwd: opts.workdir,
      dir: opts.dataDir ? join(opts.dataDir, "side-chats") : null,
      recap: () => recapBefore(this.store.since(0), this.store.latestSeq + 1, "Here is the main thread so far, for context:"),
      redact: createRedactor(this.redactions),
    });
  }

  /** Quick, read-only questions about the thread that stay out of its history. */
  readonly side: SideChats;
  /** Files uploaded to send with messages. */
  readonly attachments: Attachments;
  /** Agents the thread's agent started to work on parts of its task. */
  readonly subagents: Subagents;
  /** Cloud agents' requests for the user's own computer, answered by the desktop app. */
  readonly computer = new ComputerBridge();

  private previewList: Preview[] = [];

  /** Dev servers the agent offered for preview. */
  get previews(): readonly Preview[] {
    return this.previewList;
  }

  /** Offer (or rename) a port for preview, or take it back. */
  setPreview(port: number, name: string | null): void {
    const others = this.previewList.filter(p => p.port !== port);
    this.previewList =
      name === null
        ? others
        : [...others, { port, name: name.slice(0, 80) || `Port ${port}`, addedAt: new Date().toISOString() }].sort((a, b) => a.port - b.port);
    this.store.append({ type: "preview_update", previews: this.previewList });
  }

  get workdir(): string {
    return this.opts.workdir;
  }

  get thread(): Thread {
    return { ...this.opts.thread, status: this.status, latestSeq: this.store.latestSeq, updatedAt: new Date().toISOString() };
  }

  get idle(): string | null {
    return this.idleSince;
  }

  onStatus(listener: (s: ThreadStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Prepare the repo and branch, restore any saved agent session, and become idle. */
  async init(): Promise<void> {
    const saved = this.loadState();
    if (this.git) {
      if (this.opts.sourceRepo) {
        await this.git.ensureWorktree(this.opts.sourceRepo, this.opts.thread.branch, this.opts.thread.repo.baseBranch);
      } else {
        await this.git.ensureRepo(this.opts.repoUrl);
        await this.git.ensureBranch(this.opts.thread.branch, this.opts.thread.repo.baseBranch);
      }
      if (this.opts.dataDir) {
        const rel = relative(this.opts.workdir, this.opts.dataDir);
        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) await this.git.excludePath(rel);
      }
      this.headCommit = await this.git.head();
      await this.git.excludePath(`${ATTACHMENTS_DIR}/`);
    }
    let skills: string[] = [];
    try {
      skills = await installSkills({
        workdir: this.opts.workdir,
        kind: this.opts.adapter.kind,
        git: this.git,
        bundled: this.opts.bundledSkills ?? true,
        extraDirs: this.opts.extraSkillDirs ?? [],
        disabled: this.opts.disabledSkills ?? [],
      });
    } catch (err) {
      this.store.append({
        type: "notice",
        code: "skills_not_installed",
        message: `Couldn't add LemonLime's skills to this thread: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    await this.installPlugins(skills);
    this.agentState = saved?.agentState ?? {};
    if (typeof saved?.recap === "string" && saved.recap) this.recap = saved.recap;
    this.session = this.newSession();
    this.initialised = true;
    const open = new Set<string>();
    for (const e of this.store.since(0)) {
      if (e.type === "user_message" && e.clientMsgId) this.seen.add(e.clientMsgId);
      if (e.type === "approval_request") open.add(e.requestId);
      if (e.type === "approval_result") open.delete(e.requestId);
    }
    // Questions from a runner that has since stopped can no longer be answered.
    for (const requestId of open) this.store.append({ type: "approval_result", requestId, decision: "deny", by: "expired" });
    this.queue = (saved?.queue ?? []).filter(q => !this.seen.has(q.clientMsgId));
    for (const q of this.queue) this.seen.add(q.clientMsgId);
    this.autoContinues = saved?.autoContinues ?? [];
    const lastPreviews = [...this.store.since(0)].reverse().find(e => e.type === "preview_update");
    if (lastPreviews?.type === "preview_update") this.previewList = lastPreviews.previews;
    if (saved?.usageLimit) {
      this.usageLimit = saved.usageLimit;
      this.scheduleLimitContinue();
    }
    // A retry still waiting when the runner stopped (one already running is covered below).
    if (saved?.retry && saved.status !== "running") {
      this.retry = saved.retry;
      this.scheduleRetryTimer();
    }
    this.reportSetupLog();

    if (saved?.status === "running") {
      // The runner died mid-turn. We can't know how far the agent got, so we never run
      // that message again: keep whatever it changed, and say plainly what happened.
      await this.recordChanges(UNFINISHED_SUBJECT).catch(() => undefined);
      this.store.append({
        type: "error",
        code: "turn_outcome_unknown",
        message:
          "The runner stopped while the agent was working, so the last message may not have finished. It will not be run again. Check the changes, then ask the agent to continue if needed.",
        fatal: false,
      });
      this.setStatus("idle", "runner restarted");
    } else {
      this.setStatus("idle");
    }
    if (this.queue.length) this.publishQueue();
    this.startNext();
    if (this.opts.checkAgentVersion) void this.checkVersion();
  }

  /** Where the list of files plugins put into the workdir is kept, so they can be removed later. */
  private get pluginFilesPath(): string | null {
    return this.opts.dataDir ? join(this.opts.dataDir, "plugin-files.json") : null;
  }

  /** Put the user's enabled agent plugins into the thread (see agent-plugins.ts). */
  private async installPlugins(takenSkills: string[]): Promise<void> {
    const listFile = this.pluginFilesPath;
    let previous: string[] = [];
    try {
      if (listFile && existsSync(listFile)) {
        const parsed = JSON.parse(readFileSync(listFile, "utf8")) as unknown;
        if (Array.isArray(parsed)) previous = parsed.filter((p): p is string => typeof p === "string");
      }
    } catch {
      /* start afresh */
    }
    if (!this.opts.pluginsDir && previous.length === 0) return;
    try {
      const { plugins, problems } = this.opts.pluginsDir ? loadEnabledPlugins(this.opts.pluginsDir) : { plugins: [], problems: [] };
      const result = await installPluginsIntoThread({
        workdir: this.opts.workdir,
        kind: this.opts.adapter.kind,
        git: this.git,
        plugins,
        takenSkills,
        previous,
      });
      if (Object.keys(result.mcpServers).length) this.sessionOpts.mcpServers = result.mcpServers;
      if (listFile) {
        mkdirSync(this.opts.dataDir!, { recursive: true });
        writeFileSync(listFile, JSON.stringify(result.paths));
      }
      const notes = [...problems.map(p => `${p.name}: ${p.message}`), ...result.warnings];
      if (notes.length) {
        this.store.append({
          type: "notice",
          code: "plugins_problem",
          message: `Some of your plugins couldn't be fully added to this thread. ${notes.join(" ")}`,
        });
      }
    } catch (err) {
      this.store.append({
        type: "notice",
        code: "plugins_not_installed",
        message: `Couldn't add your plugins to this thread: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * The sandbox's setup script ran before this runner started: show what it printed, once.
   * The log's first line is its exit code (see SETUP_WRAPPER in @lemonlime/sandbox).
   */
  private reportSetupLog(): void {
    const file = this.opts.setupLog;
    if (!file || !existsSync(file)) return;
    if (this.store.since(0).some(e => e.type === "notice" && e.code.startsWith("setup_script"))) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    const [first = "", ...rest] = text.split("\n");
    const code = /^exit (\d+)$/.exec(first.trim())?.[1];
    const output = rest.join("\n").trim();
    const tail = output.length > 4000 ? `…${output.slice(-4000)}` : output;
    const ok = code === "0";
    this.store.append({
      type: "notice",
      code: ok ? "setup_script_done" : "setup_script_failed",
      message: `${ok ? "The workspace's setup script ran." : `The workspace's setup script failed${code ? ` (exit code ${code})` : ""}.`}${tail ? `\n\n${tail}` : ""}`,
    });
  }

  /** The agent CLI's version, once known (null if it couldn't be found out). */
  agentVersion: string | null = null;

  private async checkVersion(): Promise<void> {
    const kind = this.opts.adapter.kind;
    const tested = (TESTED_AGENTS as Record<string, { binary: string } | undefined>)[kind];
    if (!tested) return;
    const binary = this.opts.session.command?.[0] ?? tested.binary;
    this.agentVersion = await detectVersion(binary);
    const note = versionNotice(kind, this.agentVersion);
    if (note && !this.closing) this.store.append({ type: "notice", code: "agent_older_than_tested", message: note });
  }

  /**
   * Send a message. It starts a turn if the agent is idle, otherwise it joins the queue.
   * A message whose `clientMsgId` the thread already has is ignored, so retries are safe.
   */
  sendMessage(text: string, clientMsgId: string = randomUUID(), attachments: string[] = []): SendResult {
    if (!this.initialised) throw new Error("runner not initialised");
    if (this.seen.has(clientMsgId)) return { clientMsgId, result: "duplicate" };
    if (attachments.length) {
      const r = this.attachments.resolve(attachments);
      if ("missing" in r) throw new Error(`Some attached files haven't finished uploading (${r.missing.length}). Try sending again.`);
    }
    this.seen.add(clientMsgId);
    // The user carried on themselves: no automatic continue on top.
    if (!clientMsgId.startsWith("auto-continue-")) this.clearUsageLimit();
    // ...and no retry of the last message either: theirs comes first.
    this.cancelRetry("You sent a new message, so LemonLime stopped waiting to try the last one again.");
    // `current` is still set for a moment after a turn ends; queue then too, so two
    // turns can never run at once.
    if (this.status === "running" || this.current || this.queue.length > 0 || this.held) {
      this.queue.push({ clientMsgId, text, queuedAt: new Date().toISOString(), ...(attachments.length ? { attachments } : {}) });
      this.publishQueue();
      this.saveState();
      return { clientMsgId, result: "queued" };
    }
    this.startTurn(text, clientMsgId, attachments);
    return { clientMsgId, result: "started" };
  }

  private readonly redactions: Record<string, string>;
  private login: LoginSession | null = null;
  private lastLogin: LoginUpdate | null = null;
  private readonly loginListeners = new Set<(u: LoginUpdate) => void>();

  /** Sign-in progress for connected apps. Never stored in history. */
  onLogin(listener: (u: LoginUpdate) => void): () => void {
    this.loginListeners.add(listener);
    if (this.login && this.lastLogin) listener(this.lastLogin);
    return () => this.loginListeners.delete(listener);
  }

  /** Start signing the agent in to the user's own account (or re-send where it stands). */
  startLogin(): void {
    if (this.login) {
      if (this.lastLogin) for (const l of this.loginListeners) l(this.lastLogin);
      return;
    }
    const session = new LoginSession(
      this.opts.adapter.kind,
      u => {
        this.lastLogin = u;
        for (const l of this.loginListeners) l(u);
      },
      { cwd: this.opts.workdir, ...(this.opts.loginCommand ? { command: this.opts.loginCommand, usePty: false } : {}) },
    );
    this.login = session;
    void session
      .run()
      .then(async credential => {
        if (!credential) return;
        this.useCredential(credential);
        await this.opts.onAgentCredential?.(credential).catch(err =>
          this.store.append({
            type: "notice",
            code: "credential_not_saved",
            message: `Signed in, but LemonLime couldn't save the sign-in for your next sandboxes: ${String(err)}`,
          }),
        );
      })
      .finally(() => {
        if (this.login === session) this.login = null;
      });
  }

  loginInput(text: string): void {
    this.login?.input(text);
  }

  cancelLogin(): void {
    this.login?.cancel();
  }

  /** Make a credential take effect now, and keep its value out of every event. */
  useCredential(credential: AgentCredential): void {
    if (credential.kind === "env") {
      process.env[credential.name] = credential.value;
      this.redactions[credential.name] = credential.value;
    } else {
      for (const [i, value] of tokensIn(credential.value).entries()) this.redactions[`${credential.name}#${i + 1}`] = value;
    }
    // Signed in again (perhaps to an account with room left): carry on now, once.
    if (this.usageLimit && this.initialised) this.continueAfterLimit();
    if (this.retry?.reason === "usage_limit" && this.initialised) this.runRetry(true);
  }

  private retry: PendingRetry | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The message the current turn is for, so a retry knows which one it repeats. */
  private turnMsgId: string | null = null;

  /** A message waiting to be tried again, if any (when, and why). */
  get pendingRetry(): { at: string; reason: PendingRetry["reason"]; attempts: number } | null {
    return this.retry ? { at: this.retry.at, reason: this.retry.reason, attempts: this.retry.attempts } : null;
  }

  /**
   * After a turn failed because the provider was busy or a limit was hit: say when it will
   * be tried again and wait, or say why it won't be.
   */
  private scheduleRetry(clientMsgId: string, prompt: string, reason: PendingRetry["reason"], resetAt: string | null): void {
    const maxWait = this.opts.retryMaxWaitMs ?? 0;
    const now = Date.now();
    const same = this.retry?.clientMsgId === clientMsgId ? this.retry : null;
    const attempts = (same?.attempts ?? 0) + 1;
    const firstFailedAt = same?.firstFailedAt ?? new Date(now).toISOString();
    const deadline = Date.parse(firstFailedAt) + maxWait;
    const minWait = this.opts.retryMinWaitMs ?? RETRY_BASE_MS;
    const known = resetAt ? Date.parse(resetAt) + (reason === "usage_limit" ? 60_000 : 0) - now : null;
    const guess = reason === "overloaded" ? Math.min(RETRY_STEP_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1)) : LIMIT_RETRY_MS;
    let wait = Math.max(minWait, known ?? guess);
    const what = reason === "overloaded" ? "The AI provider is overloaded" : "Your plan's usage limit for this agent is reached";
    const giveUp = (why: string) => {
      this.retry = null;
      this.saveState();
      this.store.append({
        type: "notice",
        code: "retry_given_up",
        message: `${what}, and ${why}, so LemonLime won't try this message again. Send a message to carry on.`,
      });
    };
    if (attempts > MAX_RETRY_ATTEMPTS) return giveUp(`it was already tried ${MAX_RETRY_ATTEMPTS} times`);
    if (now + wait > deadline) {
      // A known reset beyond the limit isn't worth a try before it; a guess is cut short.
      if (known !== null && now + known > deadline) return giveUp(`it lifts ${inWords(known)} from now, later than the ${inWords(maxWait)} LemonLime may wait`);
      wait = deadline - now;
      if (wait < minWait) return giveUp(`LemonLime has already waited the ${inWords(maxWait)} it may`);
    }
    const at = new Date(now + wait).toISOString();
    this.retry = { clientMsgId, prompt, reason, attempts, firstFailedAt, at };
    this.saveState();
    this.store.append({
      type: "notice",
      code: "retry_scheduled",
      message: `${what}. LemonLime will try this message again in ${inWords(wait)}${attempts > 1 ? ` (try ${attempts + 1})` : ""}. Send a message or stop the agent to cancel.`,
      untilAt: at,
    });
    this.scheduleRetryTimer();
  }

  private scheduleRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.retry) return;
    // Timers can't wait longer than about 24 days; a long wait just checks again then.
    const wait = Math.min(2 ** 31 - 1, Math.max(0, Date.parse(this.retry.at) - Date.now()));
    this.retryTimer = setTimeout(() => this.runRetry(), wait);
    this.retryTimer.unref?.();
  }

  /** Run the waiting message again now. */
  private runRetry(now = false): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const retry = this.retry;
    if (!retry || this.closing) return;
    if (!now && Date.parse(retry.at) > Date.now() + 1000) return this.scheduleRetryTimer(); // a long wait, woken early
    // Something else is happening: the user wrote, or the computer is out of room. Try again in a minute.
    if (this.status === "running" || this.current || this.queue.length > 0 || this.held) {
      this.retry = { ...retry, at: new Date(Date.now() + 60_000).toISOString() };
      this.saveState();
      return this.scheduleRetryTimer();
    }
    this.store.append({ type: "notice", code: "retry_started", message: "Trying the last message again." });
    this.begin(retryPrompt(retry.prompt, retry.reason), retry.clientMsgId, retry.prompt);
  }

  /** Stop waiting to retry, telling the user why (nothing happens if no retry is waiting). */
  private cancelRetry(why: string): void {
    if (!this.retry) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retry = null;
    this.saveState();
    this.store.append({ type: "notice", code: "retry_cancelled", message: why });
  }

  private usageLimit: { resetAt: string | null } | null = null;
  private autoContinues: string[] = [];
  private limitTimer: ReturnType<typeof setTimeout> | null = null;

  /** The thread is waiting for the user's plan limit to lift, if so. */
  get usageLimited(): { resetAt: string | null } | null {
    return this.usageLimit;
  }

  private onUsageLimit(resetAt: string | null): void {
    const dayAgo = Date.now() - 24 * 3_600_000;
    this.autoContinues = this.autoContinues.filter(t => Date.parse(t) > dayAgo);
    if (this.autoContinues.length >= MAX_AUTO_CONTINUES_PER_DAY) {
      this.clearUsageLimit();
      this.store.append({
        type: "notice",
        code: "usage_limit_no_retry",
        message: `LemonLime already continued this thread ${MAX_AUTO_CONTINUES_PER_DAY} times today after usage limits, so it won't again. Send a message when your plan has room.`,
      });
      return;
    }
    this.usageLimit = { resetAt };
    this.saveState();
    this.store.append({
      type: "notice",
      code: "usage_limited",
      message: resetAt
        ? "Your plan's usage limit for this agent is reached. The thread will continue on its own when it resets."
        : "Your plan's usage limit for this agent is reached. The thread will try again in 30 minutes, or sooner if you sign in to another account.",
      ...(resetAt ? { untilAt: resetAt } : {}),
    });
    this.scheduleLimitContinue();
  }

  private scheduleLimitContinue(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (!this.usageLimit) return;
    const at = this.usageLimit.resetAt ? Date.parse(this.usageLimit.resetAt) + 60_000 : Date.now() + LIMIT_RETRY_MS;
    const wait = Math.min(LIMIT_MAX_WAIT_MS, Math.max(this.opts.limitMinWaitMs ?? 5_000, at - Date.now()));
    this.limitTimer = setTimeout(() => this.continueAfterLimit(), wait);
    this.limitTimer.unref?.();
  }

  private continueAfterLimit(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (!this.usageLimit || this.closing) return;
    this.usageLimit = null;
    // Something is already happening (the user wrote, or a queued message runs): nothing to add.
    if (this.status === "running" || this.current || this.queue.length > 0) return this.saveState();
    const now = new Date().toISOString();
    this.autoContinues.push(now);
    this.saveState();
    this.sendMessage(CONTINUE_AFTER_LIMIT, `auto-continue-${Date.now()}`);
  }

  private clearUsageLimit(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.usageLimit) {
      this.usageLimit = null;
      this.saveState();
    }
  }

  /** Answer an approval request. Returns false if it was already decided or doesn't exist. */
  answerApproval(requestId: string, decision: ApprovalDecision): boolean {
    const finish = this.approvals.get(requestId);
    if (!finish) return false;
    finish(decision, "user");
    return true;
  }

  /** Messages waiting for the current turn to finish, oldest first. */
  get queued(): readonly QueuedMessage[] {
    return this.queue;
  }

  /** Wait until the agent is idle with nothing queued. */
  async settled(): Promise<void> {
    while (this.current) await this.current;
  }

  /**
   * Change a message still waiting in the queue. Returns false when it isn't there any
   * more (it already started, or never was). `send_now` moves it to the front and stops
   * the current turn, so the agent turns to it straight away.
   */
  editQueued(
    clientMsgId: string,
    change: { action: "update"; text: string } | { action: "remove" } | { action: "move"; toIndex: number } | { action: "send_now" },
  ): boolean {
    const i = this.queue.findIndex(q => q.clientMsgId === clientMsgId);
    if (i < 0) return false;
    const [item] = this.queue.splice(i, 1);
    switch (change.action) {
      case "update":
        this.queue.splice(i, 0, { ...item!, text: change.text });
        break;
      case "remove":
        break;
      case "move":
        this.queue.splice(Math.min(change.toIndex, this.queue.length), 0, item!);
        break;
      case "send_now":
        this.queue.unshift(item!);
        break;
    }
    this.publishQueue();
    this.saveState();
    if (change.action === "send_now") {
      if (this.current) this.interrupt();
      else this.startNext();
    }
    return true;
  }

  private held: string | null = null;

  /**
   * Stop the current turn and start no new ones until `release()`; messages sent meanwhile
   * wait in the queue. Used when the computer or sandbox is out of room.
   */
  hold(reason: string): void {
    if (this.held) return;
    this.held = reason;
    this.interrupt();
  }

  release(): void {
    if (!this.held) return;
    this.held = null;
    this.startNext();
  }

  get heldFor(): string | null {
    return this.held;
  }

  /** Stop the agent's current turn. Queued messages still run afterwards. */
  interrupt(): void {
    this.abort?.abort();
    // Stopping the agent also stops a wait to try a message again (not on the way out, though).
    if (!this.closing && !this.held) this.cancelRetry("Stopped: LemonLime won't try the last message again.");
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.side.closeAll();
    await this.subagents.close();
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.interrupt();
    await this.current?.catch(() => undefined);
    await this.session?.dispose();
  }

  private closing = false;

  private startTurn(text: string, clientMsgId: string, attachmentIds: string[] = []): void {
    const resolved = attachmentIds.length ? this.attachments.resolve(attachmentIds) : { ok: [] as Upload[] };
    const files = "ok" in resolved ? resolved.ok : [];
    this.store.append({
      type: "user_message",
      text,
      clientMsgId,
      ...(this.headCommit ? { commit: this.headCommit } : {}),
      ...(files.length ? { attachments: files.map(f => ({ id: f.id, name: f.name, size: f.size, path: f.path! })) } : {}),
    });
    const prompt = files.length ? `${text}\n\n${attachmentNote(files)}` : text;
    this.begin(prompt, clientMsgId, prompt);
  }

  /** Run one turn: `prompt` goes to the agent; `original` is what a retry would send again. */
  private begin(prompt: string, clientMsgId: string, original: string): void {
    this.setStatus("running");
    const abort = new AbortController();
    this.abort = abort;
    this.turnMsgId = clientMsgId;
    const turn = this.runTurn(prompt, abort, original).finally(() => {
      if (this.current === turn) this.current = null;
      this.startNext();
    });
    this.current = turn;
  }

  /** Start the oldest queued message if the agent is free. */
  private startNext(): void {
    if (this.closing || this.held || this.status === "running" || this.current || !this.queue.length) return;
    const next = this.queue.shift()!;
    this.publishQueue();
    this.startTurn(next.text, next.clientMsgId, next.attachments ?? []);
  }

  private publishQueue(): void {
    this.store.append({ type: "queue_update", queue: this.queue.map(q => ({ ...q })) });
  }

  private newSession(): AgentSession {
    return this.opts.adapter.createSession({ ...this.sessionOpts, cwd: this.opts.workdir, saved: this.agentState });
  }

  private async runTurn(prompt: string, abort: AbortController, original = prompt): Promise<void> {
    const clientMsgId = this.turnMsgId ?? "";
    const quietMs = this.opts.quietNoticeMs ?? DEFAULT_QUIET_MS;
    const timeoutMs = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const started = Date.now();
    let lastOutput = started;
    let toldQuiet = false;
    let timedOut = false;
    let waitingForUser = 0;
    const emit = (e: NewEvent) => {
      lastOutput = Date.now();
      toldQuiet = false;
      this.store.append(e);
    };
    const watchdog = setInterval(
      () => {
        const now = Date.now();
        if (now - started >= timeoutMs) {
          timedOut = true;
          abort.abort();
        } else if (!toldQuiet && waitingForUser === 0 && now - lastOutput >= quietMs) {
          toldQuiet = true;
          const minutes = Math.round((now - lastOutput) / 60_000);
          this.store.append({
            type: "notice",
            code: "agent_quiet",
            message: `The agent hasn't printed anything for ${minutes > 0 ? `${minutes} minutes` : "a while"}. It may be running a long command, or it may be stuck. You can stop it at any time.`,
          });
        }
      },
      Math.max(10, Math.min(30_000, Math.floor(quietMs / 4), Math.floor(timeoutMs / 4))),
    );
    watchdog.unref?.();

    let usageLimitAt: { resetAt: string | null } | null = null;
    let retryable: { reason: PendingRetry["reason"]; resetAt: string | null } | null = null;
    const retrying = (this.opts.retryMaxWaitMs ?? 0) > 0;
    try {
      if (!this.session) this.session = this.newSession();
      const requestApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
        waitingForUser += 1;
        try {
          return await this.askUser(req, abort.signal);
        } finally {
          waitingForUser -= 1;
          lastOutput = Date.now();
        }
      };
      const recap = this.recap;
      this.recap = null;
      await this.session.runTurn({ prompt: recap ? `${recap}\n\n${prompt}` : prompt, signal: abort.signal, emit, requestApproval });
      this.crashes = 0;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      const resetAt = (err as { resetAt?: string }).resetAt ?? null;
      if (code === "agent_crashed") await this.handleCrash(message, emit);
      else if (code === "usage_limit" || (code === "overloaded" && retrying)) {
        this.crashes = 0;
        emit({ type: "error", message, code, fatal: false });
        if (retrying) retryable = { reason: code, resetAt };
        else usageLimitAt = { resetAt };
      } else {
        this.crashes = 0;
        const hint = fixHint(code, this.opts.adapter.kind);
        emit({ type: "error", message: hint ? `${message}\n\n${hint}` : message, ...(code ? { code } : {}), fatal: false });
      }
    } finally {
      clearInterval(watchdog);
    }
    if (timedOut) {
      const hours = Math.round((timeoutMs / 3_600_000) * 10) / 10;
      emit({
        type: "error",
        code: "turn_timeout",
        message: `Stopped the agent after ${hours} hours on one message. Its changes so far are kept. Send a message to continue.`,
        fatal: false,
      });
    }
    try {
      await this.recordChanges(prompt);
    } catch (err) {
      emit({ type: "error", message: `Could not record file changes: ${err instanceof Error ? err.message : String(err)}`, code: "git_failed", fatal: false });
    }
    this.abort = null;
    this.idleSince = new Date().toISOString();
    this.setStatus("idle", timedOut ? "timed out" : abort.signal.aborted ? "interrupted" : undefined);
    if (usageLimitAt) this.onUsageLimit(usageLimitAt.resetAt);
    if (retryable && !abort.signal.aborted && !this.closing) this.scheduleRetry(clientMsgId, original, retryable.reason, retryable.resetAt);
    else if (this.retry?.clientMsgId === clientMsgId && !this.closing) {
      // This was a retry and it went through (or failed for another reason): nothing more to wait for.
      this.retry = null;
      this.saveState();
    }
  }

  /** Record an approval request and wait for the user, a timeout, or the turn ending. */
  private askUser(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = (decision: ApprovalDecision, by: "user" | "timeout" | "interrupted") => {
        if (!this.approvals.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.store.append({ type: "approval_result", requestId, decision, by });
        resolve(decision);
      };
      const onAbort = () => finish("deny", "interrupted");
      const timer = setTimeout(() => finish("deny", "timeout"), this.opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      // Listen for the answer before announcing the question, so even an instant answer counts.
      this.approvals.set(requestId, finish);
      this.store.append({ type: "approval_request", requestId, tool: req.tool, input: req.input, summary: req.summary });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Restart a crashed agent once; if it crashes again straight away, stop trying. */
  private async handleCrash(message: string, emit: (e: NewEvent) => void): Promise<void> {
    this.crashes += 1;
    const old = this.session;
    this.session = null;
    if (old) {
      this.agentState = old.saveState();
      await old.dispose().catch(() => undefined);
    }
    if (this.crashes === 1) {
      emit({ type: "error", code: "agent_crashed", message, fatal: false });
      this.session = this.newSession();
      emit({
        type: "notice",
        code: "agent_restarted",
        message: "The agent stopped unexpectedly, so it was restarted. Your next message continues the same conversation.",
      });
    } else {
      emit({
        type: "error",
        code: "process_lost",
        message: `The agent stopped unexpectedly again (${message}), so LemonLime stopped restarting it. Sending a message starts it again; if this keeps happening, check that the agent works in a terminal.`,
        fatal: false,
      });
    }
  }

  private async recordChanges(prompt: string): Promise<void> {
    if (!this.git) return;
    const changes = await this.git.collectChanges();
    for (const c of changes) this.store.append({ type: "file_diff", path: c.path, change: c.change, diff: c.diff, truncated: c.truncated });
    if (changes.length) this.headCommit = (await this.git.commit(commitSubject(prompt))) ?? this.headCommit;
    if (this.opts.pushBranch && (changes.length || this.unpushed)) {
      const problem = await this.git.push(this.opts.thread.branch, { force: this.rewound });
      if (!problem) this.rewound = false;
      this.unpushed = problem !== null;
      if (problem) {
        this.store.append({
          type: "notice",
          code: "push_failed",
          message: `Couldn't push ${this.opts.thread.branch} to GitHub, so the changes are only in the sandbox for now. LemonLime tries again after the next turn. Git said: ${problem}`,
        });
      }
    }
  }

  /** A commit that hasn't reached origin yet, retried after the next turn. */
  private unpushed = false;
  /** The thread branch's commit, kept current so each user message can record it. */
  private headCommit: string | null = null;
  /** The branch was moved back by a rewind, so the next push replaces the remote one. */
  private rewound = false;
  /** What the thread said before a rewind, handed to the fresh agent conversation once. */
  private recap: string | null = null;

  /**
   * Go back to the user message at `toSeq`: stop the agent, drop waiting messages, start
   * a fresh agent conversation that gets a recap of everything before that message, and,
   * with `restoreFiles`, put the branch back to where it was when that message was sent
   * (the work after it is kept at a backup ref). Returns the message's text, for editing.
   */
  async rewind(toSeq: number, restoreFiles: boolean): Promise<{ text: string } | { error: string }> {
    const target = this.store.since(toSeq - 1).find(e => e.seq === toSeq);
    if (!target || target.type !== "user_message") return { error: "That isn't one of your messages." };
    if (restoreFiles && (!this.git || !target.commit)) return { error: "There's no saved point to restore files to for that message." };
    this.queue = [];
    this.publishQueue();
    this.clearUsageLimit();
    this.interrupt();
    await this.current?.catch(() => undefined);
    let restoredTo: string | undefined;
    let backupRef: string | undefined;
    if (restoreFiles && this.git && target.commit) {
      backupRef = `refs/lemonlime/rewind/${Date.now()}`;
      await this.git.rewindTo(target.commit, backupRef);
      restoredTo = target.commit;
      this.headCommit = target.commit;
      this.rewound = true;
      this.unpushed = Boolean(this.opts.pushBranch);
    }
    // Everything the agent knew came from this conversation, so it starts again from a recap.
    await this.session?.dispose();
    this.session = null;
    this.agentState = {};
    this.recap = recapBefore(this.store.since(0), toSeq);
    this.store.append({ type: "rewind", toSeq, ...(restoredTo ? { restoredTo } : {}), ...(backupRef ? { backupRef } : {}) });
    this.saveState();
    return { text: target.text };
  }

  /** Where moved threads are packed and unpacked. */
  private get teleportDir(): string {
    return this.opts.dataDir ? join(this.opts.dataDir, "teleport") : join(this.opts.workdir, ATTACHMENTS_DIR, ".teleport");
  }

  /** Pack this thread to move it to another computer or the cloud. */
  async exportForTeleport(): Promise<TeleportExport> {
    await this.current?.catch(() => undefined);
    return exportThread({ git: this.git, baseBranch: this.opts.thread.repo.baseBranch, events: withoutRewound(this.store.since(0)), dir: this.teleportDir });
  }

  /** A packed file, by transfer id and name ("bundle" or "history.json"). */
  teleportFile(transferId: string, name: "bundle" | "history.json"): string | null {
    if (!/^[0-9a-f-]{36}$/.test(transferId)) return null;
    const file = join(this.teleportDir, transferId, name);
    return existsSync(file) ? file : null;
  }

  /**
   * Take in a thread moved from elsewhere: its commits onto this (still empty) branch, its
   * history, and a recap so the agent carries on the same conversation.
   */
  async importTeleport(o: { transferId: string; checksum: string; bundle: Buffer | null; history: Buffer; from: string }): Promise<ImportResult> {
    if (this.status === "running" || this.current) return { ok: false, status: 409, error: "The agent is working; try again when it's done." };
    const r = await importThread({
      git: this.git,
      baseBranch: this.opts.thread.repo.baseBranch,
      transferId: o.transferId,
      checksum: o.checksum,
      bundle: o.bundle,
      history: o.history,
      markerDir: join(this.teleportDir, "imported"),
    });
    if (!r.ok || r.already) return r;
    for (const e of r.events) this.store.append(e);
    if (r.headCommit) {
      this.headCommit = r.headCommit;
      this.unpushed = Boolean(this.opts.pushBranch);
    }
    this.store.append({
      type: "notice",
      code: "teleported",
      message: `Moved here from ${o.from}, with its history${r.headCommit ? " and commits" : ""}. The agent carries on from a recap.`,
    });
    await this.session?.dispose();
    this.session = null;
    this.agentState = {};
    this.recap = recapBefore(
      this.store.since(0),
      this.store.latestSeq + 1,
      `This conversation was moved here from ${o.from}. Here is what was said before, for context:`,
    );
    this.saveState();
    return r;
  }

  /** Shrink the agent's conversation. Only Claude Code has a way to do it from outside. */
  compact(): boolean {
    if (this.opts.adapter.kind !== "claude-code") return false;
    this.sendMessage("/compact");
    return true;
  }

  private setStatus(to: ThreadStatus, reason?: string): void {
    const from = this.status;
    if (from !== to || reason) {
      this.store.append({ type: "status_change", from, to, ...(reason ? { reason } : {}) });
    }
    this.status = to;
    if (to === "idle" && !this.idleSince) this.idleSince = new Date().toISOString();
    if (to === "running") this.idleSince = null;
    this.saveState();
    for (const l of this.statusListeners) l(to);
  }

  private stateFile(): string | null {
    return this.opts.dataDir ? join(this.opts.dataDir, "state.json") : null;
  }

  private loadState(): SavedState | null {
    const f = this.stateFile();
    if (!f || !existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as SavedState;
    } catch {
      return null;
    }
  }

  private saveState(): void {
    const f = this.stateFile();
    if (!f) return;
    mkdirSync(this.opts.dataDir!, { recursive: true });
    const state: SavedState = {
      agentState: this.session?.saveState() ?? this.agentState,
      status: this.status,
      queue: this.queue,
      ...(this.usageLimit ? { usageLimit: this.usageLimit } : {}),
      ...(this.autoContinues.length ? { autoContinues: this.autoContinues } : {}),
      ...(this.recap ? { recap: this.recap } : {}),
      ...(this.retry ? { retry: this.retry } : {}),
    };
    // Write a new file and move it into place, so a crash or a full disk mid-write leaves the
    // previous state whole rather than a torn file. A failed save is retried at the next one.
    const tmp = `${f}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, f);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing to clean up.
      }
      process.stderr.write(`lemonlime-runner: couldn't save thread state (${(err as Error).message})\n`);
    }
  }
}

/** Long string values in a JSON credential file (tokens), to keep out of history. */
export function tokensIn(json: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.length >= 20 && !/\s/.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(json));
  } catch {
    if (json.trim().length >= 20) out.push(json.trim());
  }
  return out;
}

/** Most of a recap kept for the agent: the newest part, if the conversation was long. */
const RECAP_CHARS = 24_000;

/** The conversation before `toSeq`, as plain text a fresh agent conversation can start from. */
export function recapBefore(
  events: readonly ThreadEvent[],
  toSeq: number,
  intro = "This conversation was rewound. Here is what was said before, for context (files are as they are now):",
): string | null {
  const hidden: [number, number][] = [];
  for (const e of events) if (e.type === "rewind") hidden.push([e.toSeq, e.seq]);
  const lines: string[] = [];
  for (const e of events) {
    if (e.seq >= toSeq) break;
    if (hidden.some(([from, to]) => e.seq >= from && e.seq < to)) continue;
    if (e.type === "user_message") lines.push(`User: ${e.text}`);
    else if (e.type === "agent_message" && !e.partial) lines.push(`You: ${e.text}`);
  }
  if (!lines.length) return null;
  let body = lines.join("\n\n");
  if (body.length > RECAP_CHARS) body = `…${body.slice(-RECAP_CHARS)}`;
  return `${intro}\n\n${body}\n\nThe user's next message follows.`;
}
