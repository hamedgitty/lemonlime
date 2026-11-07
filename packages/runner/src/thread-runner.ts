import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { NewEvent, Preview, QueuedMessage, Thread, ThreadEvent, ThreadStatus } from "@lemonlime/protocol";
import { randomUUID } from "node:crypto";
import { detectVersion, TESTED_AGENTS, versionNotice, type AgentAdapter, type AgentSession, type SessionOptions } from "./agents/index.ts";
import { SideChats } from "./side-chats.ts";
import { Subagents } from "./subagents.ts";
import { attachmentNote, Attachments, ATTACHMENTS_DIR, type Upload } from "./attachments.ts";
import { EventStore } from "./event-store.ts";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.ts";
import { commitSubject, GitWorkspace } from "./git.ts";
import { type AgentCredential, LoginSession, type LoginUpdate } from "./login.ts";
import { createRedactor } from "./redact.ts";
import { installSkills } from "./skills.ts";

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
  /** Every clientMsgId this thread has accepted, so a resend never runs twice. */
  private readonly seen = new Set<string>();

  constructor(private readonly opts: ThreadRunnerOptions) {
    this.redactions = { ...opts.redact };
    this.store = new EventStore(opts.thread.id, opts.dataDir ? join(opts.dataDir, "events.jsonl") : null, createRedactor(this.redactions));
    this.status = opts.thread.status;
    this.git = opts.git === false ? null : new GitWorkspace(opts.workdir, opts.credentialHelper);
    this.attachments = new Attachments(opts.workdir);
    this.subagents = new Subagents({
      adapter: opts.adapter,
      session: opts.session,
      cwd: opts.workdir,
      toMain: (text, id) => {
        if (!this.closing) this.sendMessage(text, `subagent-${id}`);
      },
      notice: (code, message) => this.store.append({ type: "notice", code, message }),
    });
    const { autonomy: _a, ...session } = opts.session;
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
    try {
      await installSkills({
        workdir: this.opts.workdir,
        kind: this.opts.adapter.kind,
        git: this.git,
        bundled: this.opts.bundledSkills ?? true,
        extraDirs: this.opts.extraSkillDirs ?? [],
      });
    } catch (err) {
      this.store.append({
        type: "notice",
        code: "skills_not_installed",
        message: `Couldn't add LemonLime's skills to this thread: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    this.agentState = saved?.agentState ?? {};
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
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.side.closeAll();
    await this.subagents.close();
    if (this.limitTimer) clearTimeout(this.limitTimer);
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
    this.setStatus("running");
    const abort = new AbortController();
    this.abort = abort;
    const prompt = files.length ? `${text}\n\n${attachmentNote(files)}` : text;
    const turn = this.runTurn(prompt, abort).finally(() => {
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
    return this.opts.adapter.createSession({ ...this.opts.session, cwd: this.opts.workdir, saved: this.agentState });
  }

  private async runTurn(prompt: string, abort: AbortController): Promise<void> {
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
      if (code === "agent_crashed") await this.handleCrash(message, emit);
      else if (code === "usage_limit") {
        this.crashes = 0;
        emit({ type: "error", message, code, fatal: false });
        usageLimitAt = { resetAt: (err as { resetAt?: string }).resetAt ?? null };
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
    };
    writeFileSync(f, JSON.stringify(state, null, 2));
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
