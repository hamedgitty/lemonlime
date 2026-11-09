import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { installCoauthorHooks } from "./coauthors.ts";
import {
  DEFAULT_ACCOUNT_ID,
  hasAccounts,
  PERMISSION_MODES,
  PermissionMode,
  ReasoningLevel,
  withoutRewound,
  type AccountRef,
  type AgentCommand,
  type AgentConfig,
  type AgentKind,
  type OnLimit,
  type NewEvent,
  type Preview,
  type Question,
  type QueuedMessage,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
  type ThreadStatus,
  type UsageWindow,
} from "@lemonlime/protocol";
import { capabilitiesFor } from "./capabilities.ts";
import { randomUUID } from "node:crypto";
import { adapterFor, detectVersion, TESTED_AGENTS, versionNotice, type AgentAdapter, type AgentSession, type SessionOptions } from "./agents/index.ts";
import {
  ACCOUNT_ENV,
  accountDir,
  accountEnv,
  accountRef,
  accountsOf,
  carrySession,
  defaultAccount,
  loadAccounts,
  looksSignedIn,
  nextAccount,
  saveAccountUsage,
  signedInAgents,
  usualAgentDir,
} from "./accounts.ts";
import { buildHandoff } from "./handoff.ts";
import { SideChats } from "./side-chats.ts";
import { Subagents } from "./subagents.ts";
import { ComputerBridge } from "./computer.ts";
import { exportThread, importThread, type ImportResult, type TeleportExport } from "./teleport.ts";
import { attachmentNote, Attachments, ATTACHMENTS_DIR, type Upload } from "./attachments.ts";
import { EventStore } from "./event-store.ts";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.ts";
import { commitSubject, GitWorkspace } from "./git.ts";
import { GitReview } from "./git-review.ts";
import { lookupPullRequest, preparePullRequestBranch, type PullRequestCheckout } from "./git-start.ts";
import { PullRequestWatcher } from "./pr-watch.ts";
import { type AgentCredential, LoginSession, type LoginUpdate } from "./login.ts";
import { createRedactor } from "./redact.ts";
import { installSkills } from "./skills.ts";
import { installPluginsIntoThread, loadEnabledPlugins } from "./agent-plugins.ts";
import { listCommands } from "./composer.ts";

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
  /**
   * How a new thread's branch starts (with `sourceRepo`): from `from` (a fork starts from the
   * thread it came from), on a branch that's already there (`existing`), or on a pull
   * request's branch (`pullRequest`, its number; the thread's branch is its local name).
   */
  start?: { from?: string; existing?: boolean; pullRequest?: number };
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
  /**
   * LemonLime's home on the user's own computer, where their extra agent accounts live
   * (see accounts.ts). Unset (cloud sandboxes): the agent's one sign-in, no switching.
   */
  accountsHome?: string | null;
  /** What to do at a usage limit; default: the user's setting in accountsHome, else wait. */
  onLimit?: () => OnLimit;
  /** Other agents signed in here (default: a look at their config folders). */
  signedInAgents?: () => AgentKind[];
  /** Whether an account looks signed in (default: a look at its folder). */
  accountSignedIn?: (agent: AgentKind, accountId: string) => boolean;
  /** The adapter for another agent, when the thread moves to it (tests swap it). */
  adapterFor?: (kind: AgentKind) => AgentAdapter;
}

/** A turn that stopped on a usage limit, until something carries the thread on. */
interface LimitStop {
  clientMsgId: string;
  /** The message as the agent first got it, to run again. */
  prompt: string;
  agent: AgentKind;
  account: string | null;
  resetAt: string | null;
  at: string;
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
  /** Model, reasoning and permission mode, once changed from what the thread started with. */
  options?: ThreadOptions;
  /** The agent, once the thread moved to another one than it started with. */
  agent?: AgentConfig;
  /** The account the agent uses (see accounts.ts), on computers with more than one. */
  account?: string;
  /** The turn stopped on a usage limit, until something carried the thread on. */
  limitStop?: LimitStop;
}

/** A change to the thread's options (see ThreadRunner.setOptions). */
export interface OptionsChange {
  model?: string | null;
  reasoning?: ReasoningLevel | null;
  permission?: PermissionMode;
  fast?: boolean;
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

  /** Questions waiting for the user's answers, by request id. */
  private readonly questions = new Map<string, (answers: string[][] | null, by: "user" | "timeout" | "interrupted") => void>();

  /** How many approvals and questions the agent is waiting on (for /healthz, so apps can notify). */
  get waitingApprovals(): number {
    return this.approvals.size + this.questions.size;
  }

  /** The thread's model, reasoning and permission mode now. */
  private options: ThreadOptions;
  /** The session must be started again before its next turn to pick up changed options. */
  private sessionStale = false;

  get currentOptions(): ThreadOptions {
    return { ...this.options };
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
    // The environment object is shared with subagents and side chats, and changed in place
    // (accounts), so they all follow the thread's account.
    this.sessionOpts = { ...opts.session, env: { ...opts.session.env, ...hooksEnv } };
    this.adapter = opts.adapter;
    // Subagents and side chats use whichever agent the thread uses now.
    const live: AgentAdapter = {
      get kind() {
        return runnerAdapter().kind;
      },
      createSession: o => runnerAdapter().createSession(o),
    };
    const runnerAdapter = () => this.adapter;
    const startMode = PermissionMode.safeParse(opts.session.autonomy);
    const reasoning = ReasoningLevel.safeParse(opts.session.reasoning ?? opts.thread.agent.reasoning);
    this.options = {
      model: opts.session.model ?? opts.thread.agent.model ?? null,
      reasoning: reasoning.success ? reasoning.data : null,
      permission: startMode.success ? startMode.data : "edits",
      ...((opts.session.fast ?? opts.thread.agent.fast) ? { fast: true } : {}),
    };
    if (this.options.fast) this.sessionOpts.fast = true;
    this.redactions = { ...opts.redact };
    this.store = new EventStore(opts.thread.id, opts.dataDir ? join(opts.dataDir, "events.jsonl") : null, createRedactor(this.redactions));
    this.status = opts.thread.status;
    this.git = opts.git === false ? null : new GitWorkspace(opts.workdir, opts.credentialHelper);
    this.attachments = new Attachments(opts.workdir);
    this.subagents = new Subagents({
      adapter: live,
      session: this.sessionOpts,
      cwd: opts.workdir,
      toMain: (text, id) => {
        if (!this.closing) this.sendMessage(text, `subagent-${id}`);
      },
      notice: (code, message) => this.store.append({ type: "notice", code, message }),
      changed: subagents => {
        if (!this.closing) this.store.append({ type: "subagent_update", subagents });
      },
    });
    const { autonomy: _a, ...session } = this.sessionOpts;
    this.side = new SideChats({
      threadId: opts.thread.id,
      adapter: live,
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

  /** Slash commands for the composer's `/` menu: what the agent reported, plus command files and skills. */
  get agentCommands(): AgentCommand[] {
    return listCommands({ kind: this.adapter.kind, workdir: this.opts.workdir, reported: this.session?.commands?.() ?? [] });
  }

  private reviewer: GitReview | null | undefined;
  /** The pull request this thread was started on, once its branch is set up. */
  private pullRequestCheckout: PullRequestCheckout | null = null;
  /** The thread's branch for review: real diffs, push and pull requests. Null without git. */
  get review(): GitReview | null {
    if (this.reviewer !== undefined) return this.reviewer;
    const firstMessage = () => {
      const first = this.store.since(0).find(e => e.type === "user_message");
      return first && first.type === "user_message" ? first.text : "";
    };
    const pr = this.pullRequestCheckout;
    try {
      this.reviewer = this.git
        ? new GitReview(this.git, {
            branch: this.opts.thread.branch,
            baseBranch: this.opts.thread.repo.baseBranch,
            threadId: this.opts.thread.id,
            title: () => this.opts.thread.title || (firstMessage() ? commitSubject(firstMessage()) : ""),
            firstMessage,
            ...(pr ? { pushTarget: pr.pushTarget, pullRequestNumber: pr.number, ...(pr.pushProblem ? { pushProblem: pr.pushProblem } : {}) } : {}),
            ownFolder: Boolean(this.opts.sourceRepo || this.opts.repoUrl),
            busy: () => (this.status === "running" || this.current ? "The agent is working. Wait for it to finish, then try again." : null),
            onHeadMoved: () => {
              void this.git?.head().then(h => (this.headCommit = h ?? this.headCommit));
              if (this.opts.pushBranch) this.unpushed = true;
            },
          })
        : null;
    } catch {
      this.reviewer = null;
    }
    const review = this.reviewer;
    if (review && !review.watcher) {
      review.watcher = new PullRequestWatcher({
        file: this.opts.dataDir ? join(this.opts.dataDir, "pr-watch.json") : null,
        snapshot: () => review.watchSnapshot(),
        baseBranch: this.opts.thread.repo.baseBranch,
        wake: (text, id) => {
          if (!this.closing && this.initialised) this.sendMessage(text, id);
        },
        notice: message => this.store.append({ type: "notice", code: "pr_watch", message }),
      });
    }
    return this.reviewer;
  }

  /** Set up a pull request's branch the first time (saved, so a restart doesn't look it up again). */
  private async preparePullRequest(source: string, number: number): Promise<void> {
    const file = this.opts.dataDir ? join(this.opts.dataDir, "pull-request.json") : null;
    if (file && existsSync(file)) {
      try {
        this.pullRequestCheckout = JSON.parse(readFileSync(file, "utf8")) as PullRequestCheckout;
        return;
      } catch {
        /* look it up again */
      }
    }
    const lookup = await lookupPullRequest(source, `#${number}`);
    if (lookup.localBranch !== this.opts.thread.branch) throw new Error(`Pull request #${number} is on ${lookup.localBranch}, not ${this.opts.thread.branch}.`);
    this.pullRequestCheckout = await preparePullRequestBranch(source, lookup);
    if (file) {
      mkdirSync(this.opts.dataDir!, { recursive: true });
      writeFileSync(file, JSON.stringify(this.pullRequestCheckout));
    }
    if (this.pullRequestCheckout.pushProblem) this.store.append({ type: "notice", code: "pr_push_blocked", message: this.pullRequestCheckout.pushProblem });
  }

  get thread(): Thread {
    return {
      ...this.opts.thread,
      agent: this.threadAgent ?? this.opts.thread.agent,
      status: this.status,
      latestSeq: this.store.latestSeq,
      updatedAt: new Date().toISOString(),
    };
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
    // A thread that moved to another agent carries on with it.
    if (saved?.agent && saved.agent.kind !== this.adapter.kind) {
      this.adapter = (this.opts.adapterFor ?? adapterFor)(saved.agent.kind);
      this.threadAgent = saved.agent;
      delete this.sessionOpts.command;
    }
    if (saved?.limitStop) this.limitStop = saved.limitStop;
    // A thread keeps its account. One that ran before accounts existed ran on the usual sign-in.
    const ranBefore = Object.keys(saved?.agentState ?? {}).length > 0;
    this.setAccount(typeof saved?.account === "string" ? saved.account : ranBefore ? DEFAULT_ACCOUNT_ID : null);
    if (this.git) {
      if (this.opts.sourceRepo) {
        const start = this.opts.start ?? {};
        if (start.pullRequest) await this.preparePullRequest(this.opts.sourceRepo, start.pullRequest);
        const made = await this.git.ensureWorktree(this.opts.sourceRepo, this.opts.thread.branch, this.opts.thread.repo.baseBranch, {
          ...(start.from ? { from: start.from } : {}),
          ...(start.existing || start.pullRequest ? { existing: true } : {}),
        });
        for (const message of made.warnings) this.store.append({ type: "notice", code: "submodules_not_filled", message });
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
        kind: this.adapter.kind,
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
    // Options changed in an earlier run win over the ones the runner was started with.
    if (saved?.options && PermissionMode.safeParse(saved.options.permission).success) {
      this.options = saved.options;
      this.applyOptionsToSession();
    }
    this.session = this.newSession();
    this.initialised = true;
    // A pull request watch that was on before a restart carries on.
    void this.review;
    const open = new Set<string>();
    const asked = new Set<string>();
    for (const e of this.store.since(0)) {
      if (e.type === "user_message" && e.clientMsgId) this.seen.add(e.clientMsgId);
      if (e.type === "approval_request") open.add(e.requestId);
      if (e.type === "approval_result") open.delete(e.requestId);
      if (e.type === "question_request") asked.add(e.requestId);
      if (e.type === "question_result") asked.delete(e.requestId);
    }
    // Questions from a runner that has since stopped can no longer be answered.
    for (const requestId of open) this.store.append({ type: "approval_result", requestId, decision: "deny", by: "expired" });
    for (const requestId of asked) this.store.append({ type: "question_result", requestId, answers: null, by: "expired" });
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
        kind: this.adapter.kind,
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
    const kind = this.adapter.kind;
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
    if (!clientMsgId.startsWith("auto-continue-")) {
      this.clearUsageLimit();
      this.limitTried = null;
    }
    // ...and no retry of the last message either: theirs comes first.
    this.cancelRetry("You sent a new message, so LemonLime stopped waiting to try the last one again.");
    // `current` is still set for a moment after a turn ends; queue then too, so two
    // turns can never run at once.
    if (this.status === "running" || this.current || this.queue.length > 0 || this.held || this.switching) {
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
      this.adapter.kind,
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
    if (this.status === "running" || this.current || this.queue.length > 0 || this.held || this.switching) {
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

  // ── Usage limits: other accounts, other agents ─────────────────────────────

  /** The agent the thread uses now, once it moved from the one it started with. */
  private threadAgent: AgentConfig | null = null;
  private adapter: AgentAdapter;
  /** The account the agent signs in with (see accounts.ts); null: its one sign-in. */
  private account: string | null = null;
  private limitStop: LimitStop | null = null;
  /** Accounts that hit a limit on the message being tried, so switching never goes round in circles. */
  private limitTried: { clientMsgId: string; ids: string[] } | null = null;
  /** Switch to this account once the current turn has wrapped up (the "switch" setting). */
  private pendingSwitch: string | null = null;
  /** A switch is under way: new messages wait in the queue until it's done. */
  private switching = false;

  /** The usage limit the thread stopped on, if it's still stopped there (for /healthz). */
  get limitStopped(): { agent: AgentKind; account: string | null; resetAt: string | null } | null {
    const s = this.limitStop;
    return s ? { agent: s.agent, account: s.account, resetAt: s.resetAt } : null;
  }

  /** The agent's account, if this computer keeps several. */
  get currentAccount(): string | null {
    return this.account;
  }

  private get accountsHome(): string | null {
    return this.opts.accountsHome ?? null;
  }

  /** Use this account for the agent from its next session (null: the thread's or the user's default). */
  private setAccount(id: string | null): void {
    const env = this.sessionOpts.env!;
    for (const name of Object.values(ACCOUNT_ENV)) delete env[name];
    const kind = this.adapter.kind;
    const home = this.accountsHome;
    if (!home || !hasAccounts(kind)) {
      this.account = null;
      return;
    }
    const data = loadAccounts(home);
    const known = id !== null && accountsOf(data, kind).some(a => a.id === id);
    this.account = known ? id : defaultAccount(data, kind);
    const { name, value } = accountEnv(home, kind, this.account!);
    if (value) env[name] = value;
  }

  private accountRefFor(id: string | null): AccountRef | null {
    const kind = this.adapter.kind;
    const home = this.accountsHome;
    if (!home || !id || !hasAccounts(kind)) return null;
    const data = loadAccounts(home);
    // Only worth naming when there's more than one.
    return accountsOf(data, kind).length > 1 ? accountRef(data, kind, id) : null;
  }

  private accountSignedIn(kind: AgentKind, id: string): boolean {
    if (this.opts.accountSignedIn) return this.opts.accountSignedIn(kind, id);
    const home = this.accountsHome;
    return Boolean(home && hasAccounts(kind) && looksSignedIn(kind, accountDir(home, kind, id)));
  }

  /** Other accounts of this agent that look signed in. */
  private otherAccounts(): AccountRef[] {
    const kind = this.adapter.kind;
    const home = this.accountsHome;
    if (!home || !hasAccounts(kind)) return [];
    return accountsOf(loadAccounts(home), kind)
      .filter(a => a.id !== this.account && this.accountSignedIn(kind, a.id))
      .map(a => ({ id: a.id, label: a.label }));
  }

  private otherAgents(): AgentKind[] {
    const all = this.opts.signedInAgents ? this.opts.signedInAgents() : signedInAgents();
    return [...new Set(all)].filter(k => k !== this.adapter.kind && k !== "acp");
  }

  private limitPolicy(): OnLimit {
    if (this.opts.onLimit) return this.opts.onLimit();
    const home = this.accountsHome;
    return home ? loadAccounts(home).onLimit : "wait";
  }

  /**
   * A turn stopped on the plan's usage limit: show it (limit_hit), then do what the user
   * chose for limits: switch to their next signed-in account, wait for the reset, or leave
   * it to them.
   */
  private handleLimit(clientMsgId: string, prompt: string, hit: { resetAt: string | null; message: string }, aborted: boolean): void {
    const agent = this.adapter.kind;
    const tried = this.limitTried?.clientMsgId === clientMsgId ? this.limitTried.ids : [];
    if (this.account && !tried.includes(this.account)) tried.push(this.account);
    this.limitTried = { clientMsgId, ids: tried };
    this.limitStop = { clientMsgId, prompt, agent, account: this.account, resetAt: hit.resetAt, at: new Date().toISOString() };
    this.saveState();
    const account = this.accountRefFor(this.account);
    this.store.append({
      type: "limit_hit",
      agent,
      ...(account ? { account } : {}),
      ...(hit.resetAt ? { resetAt: hit.resetAt } : {}),
      message: hit.message,
      accounts: this.otherAccounts(),
      agents: this.otherAgents(),
    });
    if (aborted || this.closing) return;
    const policy = this.limitPolicy();
    if (policy === "switch") {
      const home = this.accountsHome;
      const ids = home && hasAccounts(agent) ? accountsOf(loadAccounts(home), agent).map(a => a.id) : [];
      const next = this.account ? nextAccount(ids, this.account, new Set(tried), id => this.accountSignedIn(agent, id)) : null;
      if (next) {
        this.pendingSwitch = next; // once this turn has wrapped up (see begin)
        return;
      }
      this.store.append({
        type: "notice",
        code: "no_account_to_switch",
        message: "There's no other signed-in account of this agent with room left, so LemonLime waits for the limit to reset instead.",
      });
    }
    if (policy === "ask") return;
    this.waitForLimit();
  }

  /** Try again once the limit resets (the "wait and try again" way). */
  private waitForLimit(): void {
    const stop = this.limitStop;
    if (!stop) return;
    if (this.usageLimit || this.retry) return; // already waiting
    if ((this.opts.retryMaxWaitMs ?? 0) > 0) this.scheduleRetry(stop.clientMsgId, stop.prompt, "usage_limit", stop.resetAt);
    else this.onUsageLimit(stop.resetAt);
  }

  /** What the user picked on a limit row. */
  async limitAction(
    action: { action: "switch_account"; accountId: string } | { action: "switch_agent"; agent: AgentKind; model: string | null } | { action: "wait" },
  ): Promise<{ ok: true } | { error: string }> {
    if (action.action === "switch_account") return this.switchAccount(action.accountId);
    if (action.action === "switch_agent") return this.switchAgent(action.agent, action.model);
    if (!this.limitStop) return { error: "This thread isn't stopped on a usage limit." };
    this.waitForLimit();
    return { ok: true };
  }

  /** Stop waiting for a reset (quietly: a switch says what happened instead). */
  private stopWaitingForLimit(): void {
    this.clearUsageLimit();
    if (this.retry?.reason === "usage_limit") {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retry = null;
    }
  }

  /** The folder an account's agent keeps its sessions in. */
  private agentDirFor(kind: AgentKind, id: string | null): string | null {
    const home = this.accountsHome;
    if (!home || !hasAccounts(kind)) return null;
    return (id ? accountDir(home, kind, id) : null) ?? usualAgentDir(kind);
  }

  /**
   * Carry on with another account of the same agent. The agent's own record of the
   * conversation is copied to that account's folder so it goes on where it stopped; if it
   * can't be, a fresh conversation starts from a handoff note. Then the message that hit
   * the limit runs again.
   */
  async switchAccount(id: string, o: { auto?: boolean } = {}): Promise<{ ok: true } | { error: string }> {
    return this.whileSwitching(() => this.doSwitchAccount(id, o));
  }

  /** Run a switch with new turns held back until it's done. */
  private async whileSwitching(run: () => Promise<{ ok: true } | { error: string }>): Promise<{ ok: true } | { error: string }> {
    if (this.switching) return { error: "Already switching. Try again in a moment." };
    this.switching = true;
    let done = false;
    try {
      const r = await run();
      done = "ok" in r;
      return r;
    } finally {
      this.switching = false;
      // The message that hit the limit goes first; then anything that queued meanwhile.
      if (done) this.continueAfterSwitch();
      this.startNext();
    }
  }

  private async doSwitchAccount(id: string, o: { auto?: boolean }): Promise<{ ok: true } | { error: string }> {
    const kind = this.adapter.kind;
    const home = this.accountsHome;
    if (!home || !hasAccounts(kind)) return { error: "Switching accounts isn't available for this thread." };
    if (this.closing) return { error: "The thread is closing." };
    const data = loadAccounts(home);
    const to = accountRef(data, kind, id);
    if (!to) return { error: "There's no such account. Add it under Settings → Agents first." };
    if (id === this.account) return { error: "The thread already uses that account." };
    if (this.status === "running" || this.current) return { error: "Wait for the agent to stop, then switch." };
    const from = this.account ? accountRef(data, kind, this.account) : null;
    const fromDir = this.agentDirFor(kind, this.account);
    const toDir = this.agentDirFor(kind, id);
    if (this.session) this.agentState = this.session.saveState();
    await this.session?.dispose().catch(() => undefined);
    this.session = null;
    let carried = Object.keys(this.agentState).length === 0;
    if (!carried && fromDir && toDir) {
      try {
        carried = carrySession(kind, this.agentState, fromDir, toDir);
      } catch {
        carried = false;
      }
    }
    if (!carried) {
      this.agentState = {};
      this.recap = buildHandoff(this.store.since(0), { from: kind, reason: "the plan's usage limit was reached on another account" });
    }
    this.setAccount(id);
    this.store.append({
      type: "agent_switch",
      from: { agent: kind, ...(from ? { account: from } : {}) },
      to: { agent: kind, account: to },
      carried: carried ? "session" : "handoff",
      auto: Boolean(o.auto),
    });
    return { ok: true };
  }

  /**
   * Carry on with another agent, in the same working folder and branch. The new agent
   * starts a fresh conversation from a handoff note built from the thread's history, with a
   * model of the same tier where the app picked one.
   */
  async switchAgent(kind: AgentKind, model: string | null, o: { auto?: boolean } = {}): Promise<{ ok: true } | { error: string }> {
    return this.whileSwitching(() => this.doSwitchAgent(kind, model, o));
  }

  private async doSwitchAgent(kind: AgentKind, model: string | null, o: { auto?: boolean }): Promise<{ ok: true } | { error: string }> {
    const fromKind = this.adapter.kind;
    if (kind === fromKind) return { error: "The thread already uses that agent." };
    if (kind === "acp") return { error: "Pick Claude Code, Codex or OpenCode." };
    if (this.closing) return { error: "The thread is closing." };
    if (this.status === "running" || this.current) return { error: "Wait for the agent to stop, then switch." };
    const from = this.accountRefFor(this.account);
    const stopped = this.limitStop;
    await this.session?.dispose().catch(() => undefined);
    this.session = null;
    this.adapter = (this.opts.adapterFor ?? adapterFor)(kind);
    const cleanModel = model?.trim() || null;
    this.threadAgent = { kind, ...(cleanModel ? { model: cleanModel } : {}) };
    delete this.sessionOpts.command;
    this.setAccount(null);
    // Keep what the new agent can do; the rest goes back to its defaults.
    const caps = capabilitiesFor(kind, { agentVersion: null });
    const permission = caps.permissions.includes(this.options.permission) ? this.options.permission : "edits";
    this.options = {
      model: cleanModel,
      reasoning: this.options.reasoning && caps.reasoning.includes(this.options.reasoning) ? this.options.reasoning : null,
      permission,
      ...(this.options.fast && caps.fast ? { fast: true } : {}),
      ...(permission === "plan" && this.options.exitPlanTo && caps.permissions.includes(this.options.exitPlanTo)
        ? { exitPlanTo: this.options.exitPlanTo }
        : {}),
    };
    this.applyOptionsToSession();
    this.agentState = {};
    this.recap = buildHandoff(this.store.since(0), {
      from: fromKind,
      ...(stopped ? { reason: "its plan's usage limit was reached" } : {}),
    });
    try {
      await installSkills({
        workdir: this.opts.workdir,
        kind,
        git: this.git,
        bundled: this.opts.bundledSkills ?? true,
        extraDirs: this.opts.extraSkillDirs ?? [],
        disabled: this.opts.disabledSkills ?? [],
      });
    } catch {
      // The agent works without them; the thread said so when it started if they failed.
    }
    const account = this.accountRefFor(this.account);
    this.store.append({ type: "options_change", options: { ...this.options } });
    this.store.append({
      type: "agent_switch",
      from: { agent: fromKind, ...(from ? { account: from } : {}) },
      to: { agent: kind, ...(account ? { account } : {}), ...(cleanModel ? { model: cleanModel } : {}) },
      carried: "handoff",
      auto: Boolean(o.auto),
    });
    return { ok: true };
  }

  /** After a switch: run the message that hit the limit again, now (or after what's queued). */
  private continueAfterSwitch(): void {
    const stop = this.limitStop;
    this.stopWaitingForLimit();
    this.saveState();
    if (!stop || this.closing) return;
    if (this.status === "running" || this.current || this.held) {
      // Something else already carries the thread on; it picks up the new account or agent.
      this.limitStop = null;
      this.saveState();
      return;
    }
    this.store.append({ type: "notice", code: "retry_started", message: "Trying the last message again." });
    this.begin(retryPrompt(stop.prompt, "usage_limit"), stop.clientMsgId, stop.prompt);
  }

  /**
   * Change the model, reasoning level or permission mode. A change made while the agent works
   * applies from its next turn, in the same conversation. Returns why not, if the agent
   * can't change that.
   */
  setOptions(change: OptionsChange): { ok: true } | { error: string } {
    const kind = this.adapter.kind;
    const caps = capabilitiesFor(kind, { agentVersion: null });
    const next: ThreadOptions = { ...this.options };
    if (change.permission !== undefined && change.permission !== next.permission) {
      if (!caps.permissions.includes(change.permission)) return { error: `This agent can't run in ${PERMISSION_MODES[change.permission].label} mode.` };
      if (change.permission === "plan") next.exitPlanTo = next.permission;
      else delete next.exitPlanTo;
      next.permission = change.permission;
    }
    if (change.model !== undefined && change.model !== next.model) {
      if (!caps.live.model) return { error: "This agent's model can't be changed in the middle of a thread." };
      next.model = change.model?.trim() || null;
    }
    if (change.reasoning !== undefined && change.reasoning !== next.reasoning) {
      if (!caps.live.reasoning || (change.reasoning !== null && !caps.reasoning.includes(change.reasoning))) {
        return { error: change.reasoning ? `This agent can't be set to ${change.reasoning} reasoning.` : "This agent's reasoning can't be changed." };
      }
      next.reasoning = change.reasoning;
    }
    if (change.fast !== undefined && change.fast !== Boolean(next.fast)) {
      if (change.fast && !caps.fast) return { error: "This agent has no fast mode." };
      if (change.fast) next.fast = true;
      else delete next.fast;
    }
    if (JSON.stringify(next) === JSON.stringify(this.options)) return { ok: true };
    this.options = next;
    this.applyOptionsToSession();
    this.store.append({ type: "options_change", options: { ...next } });
    this.saveState();
    return { ok: true };
  }

  /** Hand the current options to the agent session (now, or by starting it again before the next turn). */
  private applyOptionsToSession(): void {
    const { model, reasoning } = this.options;
    const fast = Boolean(this.options.fast);
    if (model) this.sessionOpts.model = model;
    else delete this.sessionOpts.model;
    if (reasoning) this.sessionOpts.reasoning = reasoning;
    else delete this.sessionOpts.reasoning;
    if (fast) this.sessionOpts.fast = true;
    else delete this.sessionOpts.fast;
    if (!this.session) return;
    if (this.session.setOptions) this.session.setOptions({ model, reasoning, autonomy: this.options.permission, fast });
    else this.sessionStale = true;
  }

  /** Answer the agent's questions (null declines). Returns false if they were already settled or don't exist. */
  answerQuestion(requestId: string, answers: string[][] | null): boolean {
    const finish = this.questions.get(requestId);
    if (!finish) return false;
    finish(answers, "user");
    return true;
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
    this.reviewer?.watcher?.stop();
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
    // A new turn carries the thread on: the limit it stopped on is behind it.
    this.limitStop = null;
    this.setStatus("running");
    const abort = new AbortController();
    this.abort = abort;
    this.turnMsgId = clientMsgId;
    const turn = this.runTurn(prompt, abort, original).finally(() => {
      if (this.current === turn) this.current = null;
      const next = this.pendingSwitch;
      this.pendingSwitch = null;
      if (next) void this.switchAccount(next, { auto: true }).then(() => this.startNext());
      else this.startNext();
    });
    this.current = turn;
  }

  /** Start the oldest queued message if the agent is free. */
  private startNext(): void {
    if (this.closing || this.held || this.switching || this.status === "running" || this.current || !this.queue.length) return;
    const next = this.queue.shift()!;
    this.publishQueue();
    this.startTurn(next.text, next.clientMsgId, next.attachments ?? []);
  }

  private publishQueue(): void {
    this.store.append({ type: "queue_update", queue: this.queue.map(q => ({ ...q })) });
  }

  private newSession(): AgentSession {
    this.sessionStale = false;
    return this.adapter.createSession({ ...this.sessionOpts, autonomy: this.options.permission, cwd: this.opts.workdir, saved: this.agentState });
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

    let limitHit: { resetAt: string | null; message: string } | null = null;
    let retryable: { reason: PendingRetry["reason"]; resetAt: string | null } | null = null;
    const retrying = (this.opts.retryMaxWaitMs ?? 0) > 0;
    try {
      if (this.session && this.sessionStale) {
        // Options changed and this agent can't take them mid-session: same conversation, new process.
        this.agentState = this.session.saveState();
        await this.session.dispose().catch(() => undefined);
        this.session = null;
      }
      if (!this.session) this.session = this.newSession();
      const waitFor = async <T>(ask: () => Promise<T>): Promise<T> => {
        waitingForUser += 1;
        try {
          return await ask();
        } finally {
          waitingForUser -= 1;
          lastOutput = Date.now();
        }
      };
      const requestApproval = (req: ApprovalRequest): Promise<ApprovalDecision> => waitFor(() => this.askUser(req, abort.signal));
      const askQuestions = (questions: Question[]): Promise<string[][] | null> => waitFor(() => this.askQuestions(questions, abort.signal));
      const recap = this.recap;
      this.recap = null;
      // Usage the agent reports goes with the account it ran on (computers with accounts only).
      const reportUsage = (windows: UsageWindow[]): void => {
        const home = this.accountsHome;
        const kind = this.adapter.kind;
        if (!home || !hasAccounts(kind)) return;
        try {
          saveAccountUsage(home, kind, this.account ?? DEFAULT_ACCOUNT_ID, windows);
        } catch {
          /* best effort: the bars just stay as they were */
        }
      };
      await this.session.runTurn({ prompt: recap ? `${recap}\n\n${prompt}` : prompt, signal: abort.signal, emit, requestApproval, askQuestions, reportUsage });
      this.crashes = 0;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      const resetAt = (err as { resetAt?: string }).resetAt ?? null;
      if (code === "agent_crashed") await this.handleCrash(message, emit);
      else if (code === "usage_limit") {
        // Shown as a limit row (limit_hit) once the turn is wrapped up, not as an error.
        this.crashes = 0;
        limitHit = { resetAt, message };
      } else if (code === "overloaded" && retrying) {
        this.crashes = 0;
        emit({ type: "error", message, code, fatal: false });
        retryable = { reason: code, resetAt };
      } else {
        this.crashes = 0;
        const hint = fixHint(code, this.adapter.kind);
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
    if (limitHit) this.handleLimit(clientMsgId, original, limitHit, abort.signal.aborted);
    else if (retryable && !abort.signal.aborted && !this.closing) this.scheduleRetry(clientMsgId, original, retryable.reason, retryable.resetAt);
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

  /** Record the agent's questions and wait for the user's answers, a timeout, or the turn ending. */
  private askQuestions(questions: Question[], signal: AbortSignal): Promise<string[][] | null> {
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = (answers: string[][] | null, by: "user" | "timeout" | "interrupted") => {
        if (!this.questions.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        // Exactly one answer list per question, so the agent never reads them out of line.
        const fitted = answers ? questions.map((_, i) => (answers[i] ?? []).map(a => a.trim()).filter(Boolean)) : null;
        this.store.append({ type: "question_result", requestId, answers: fitted, by });
        resolve(fitted);
      };
      const onAbort = () => finish(null, "interrupted");
      const timer = setTimeout(() => finish(null, "timeout"), this.opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.questions.set(requestId, finish);
      this.store.append({ type: "question_request", requestId, questions });
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
    if (this.adapter.kind !== "claude-code") return false;
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
      options: this.options,
      ...(this.threadAgent ? { agent: this.threadAgent } : {}),
      ...(this.account ? { account: this.account } : {}),
      ...(this.limitStop ? { limitStop: this.limitStop } : {}),
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
