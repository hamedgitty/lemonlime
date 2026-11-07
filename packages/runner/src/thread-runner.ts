import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { NewEvent, QueuedMessage, Thread, ThreadStatus } from "@lemonlime/protocol";
import { randomUUID } from "node:crypto";
import { detectVersion, TESTED_AGENTS, versionNotice, type AgentAdapter, type AgentSession, type SessionOptions } from "./agents/index.ts";
import { EventStore } from "./event-store.ts";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.ts";
import { commitSubject, GitWorkspace } from "./git.ts";
import { installSkills } from "./skills.ts";

export interface ThreadRunnerOptions {
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
}

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
    this.store = new EventStore(opts.thread.id, opts.dataDir ? join(opts.dataDir, "events.jsonl") : null);
    this.status = opts.thread.status;
    this.git = opts.git === false ? null : new GitWorkspace(opts.workdir);
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
  sendMessage(text: string, clientMsgId: string = randomUUID()): SendResult {
    if (!this.initialised) throw new Error("runner not initialised");
    if (this.seen.has(clientMsgId)) return { clientMsgId, result: "duplicate" };
    this.seen.add(clientMsgId);
    // `current` is still set for a moment after a turn ends; queue then too, so two
    // turns can never run at once.
    if (this.status === "running" || this.current || this.queue.length > 0) {
      this.queue.push({ clientMsgId, text, queuedAt: new Date().toISOString() });
      this.publishQueue();
      this.saveState();
      return { clientMsgId, result: "queued" };
    }
    this.startTurn(text, clientMsgId);
    return { clientMsgId, result: "started" };
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

  /** Stop the agent's current turn. Queued messages still run afterwards. */
  interrupt(): void {
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.interrupt();
    await this.current?.catch(() => undefined);
    await this.session?.dispose();
  }

  private closing = false;

  private startTurn(text: string, clientMsgId: string): void {
    this.store.append({ type: "user_message", text, clientMsgId });
    this.setStatus("running");
    const abort = new AbortController();
    this.abort = abort;
    const turn = this.runTurn(text, abort).finally(() => {
      if (this.current === turn) this.current = null;
      this.startNext();
    });
    this.current = turn;
  }

  /** Start the oldest queued message if the agent is free. */
  private startNext(): void {
    if (this.closing || this.status === "running" || this.current || !this.queue.length) return;
    const next = this.queue.shift()!;
    this.publishQueue();
    this.startTurn(next.text, next.clientMsgId);
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
      await this.session.runTurn({ prompt, signal: abort.signal, emit, requestApproval });
      this.crashes = 0;
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "agent_crashed") await this.handleCrash(message, emit);
      else {
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
    if (changes.length) await this.git.commit(commitSubject(prompt));
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
    const state: SavedState = { agentState: this.session?.saveState() ?? this.agentState, status: this.status, queue: this.queue };
    writeFileSync(f, JSON.stringify(state, null, 2));
  }
}
