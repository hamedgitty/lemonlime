import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { NewEvent, Thread, ThreadEvent, ThreadStatus } from "@lemonlime/protocol";
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

export class BusyError extends Error {
  constructor() {
    super("The agent is still working on the previous message. Interrupt it or wait.");
  }
}

interface SavedState {
  agentState: Record<string, string>;
  status: ThreadStatus;
}

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
    // A runner that died mid-turn comes back idle; say so in the history.
    this.setStatus("idle", saved?.status === "running" ? "runner restarted" : undefined);
  }

  /** Start a turn. Returns once the user message is recorded; the turn continues in the background. */
  sendMessage(text: string, clientMsgId?: string): ThreadEvent {
    if (this.status === "running") throw new BusyError();
    if (!this.session) throw new Error("runner not initialised");
    const userEvent = this.store.append({ type: "user_message", text, ...(clientMsgId ? { clientMsgId } : {}) });
    this.setStatus("running");
    const abort = new AbortController();
    this.abort = abort;
    this.current = this.runTurn(text, abort);
    return userEvent;
  }

  /** Wait for the current turn (if any) to finish. */
  async settled(): Promise<void> {
    await this.current;
  }

  interrupt(): void {
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.interrupt();
    await this.current?.catch(() => undefined);
    await this.session?.dispose();
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
    const state: SavedState = { agentState: this.session?.saveState() ?? {}, status: this.status };
    writeFileSync(f, JSON.stringify(state, null, 2));
  }
}
