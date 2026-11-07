import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { NewEvent, QueuedMessage, Thread, ThreadEvent, ThreadStatus } from "@lemonlime/protocol";
import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentSession, SessionOptions } from "./agents/index.ts";
import { EventStore } from "./event-store.ts";
import { commitSubject, GitWorkspace } from "./git.ts";

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
    this.session = this.opts.adapter.createSession({
      ...this.opts.session,
      cwd: this.opts.workdir,
      saved: saved?.agentState,
    });
    for (const e of this.store.since(0)) if (e.type === "user_message" && e.clientMsgId) this.seen.add(e.clientMsgId);
    this.queue = (saved?.queue ?? []).filter(q => !this.seen.has(q.clientMsgId));
    for (const q of this.queue) this.seen.add(q.clientMsgId);

    if (saved?.status === "running") {
      // The runner died mid-turn. We can't know how far the agent got, so we never run
      // that message again: keep whatever it changed, and say plainly what happened.
      await this.recordChanges(UNFINISHED_SUBJECT).catch(() => undefined);
      this.store.append({
        type: "error",
        code: "turn_outcome_unknown",
        message: "The runner stopped while the agent was working, so the last message may not have finished. It will not be run again. Check the changes, then ask the agent to continue if needed.",
        fatal: false,
      });
      this.setStatus("idle", "runner restarted");
    } else {
      this.setStatus("idle");
    }
    if (this.queue.length) this.publishQueue();
    this.startNext();
  }

  /**
   * Send a message. It starts a turn if the agent is idle, otherwise it joins the queue.
   * A message whose `clientMsgId` the thread already has is ignored, so retries are safe.
   */
  sendMessage(text: string, clientMsgId: string = randomUUID()): SendResult {
    if (!this.session) throw new Error("runner not initialised");
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

  private async runTurn(prompt: string, abort: AbortController): Promise<void> {
    const emit = (e: NewEvent) => this.store.append(e);
    try {
      await this.session!.runTurn({ prompt, signal: abort.signal, emit });
    } catch (err) {
      const code = (err as { code?: string }).code;
      emit({ type: "error", message: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}), fatal: false });
    }
    try {
      await this.recordChanges(prompt);
    } catch (err) {
      emit({ type: "error", message: `Could not record file changes: ${err instanceof Error ? err.message : String(err)}`, code: "git_failed", fatal: false });
    }
    this.abort = null;
    this.idleSince = new Date().toISOString();
    this.setStatus("idle", abort.signal.aborted ? "interrupted" : undefined);
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
    const state: SavedState = { agentState: this.session?.saveState() ?? {}, status: this.status, queue: this.queue };
    writeFileSync(f, JSON.stringify(state, null, 2));
  }
}
