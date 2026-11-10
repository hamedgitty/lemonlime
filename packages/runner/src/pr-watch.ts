import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PullRequestInfo, PullRequestWatchState } from "@lemonlime/protocol";

/**
 * Watching a thread's pull request while the user is away: when its checks fail, someone
 * comments or it can no longer merge cleanly, the agent gets a message saying what changed.
 * It checks every few minutes, and comments alone wake the agent a limited number of times,
 * so a bot that answers every push can't keep it busy forever.
 *
 * Anyone can comment on a public pull request, and the agent reads a wake-up as if the user
 * wrote it. So only comments from people who could change the code anyway reach it.
 */

/** What one look at the pull request found. */
export interface WatchSnapshot {
  number: number;
  state: PullRequestInfo["state"];
  /** The commit the checks are for. */
  headSha: string;
  checks: NonNullable<PullRequestInfo["checks"]>;
  /** Names of the checks that failed. */
  failing: string[];
  /** GitHub says the branch has merge conflicts with its base. */
  conflicting: boolean;
  comments: {
    id: string;
    author: string;
    body: string;
    at: string;
    path?: string;
    /** Written by someone who can push to the repository, or by the pull request's author. The rest never reach the agent. */
    trusted: boolean;
  }[];
}

/** Most times comments alone wake the agent. */
export const MAX_COMMENT_WAKES = 10;
/** Say so once when no checks have shown up by then. */
export const NO_CHECKS_AFTER_MS = 15 * 60_000;
/** How often it looks. */
export const WATCH_EVERY_MS = 3 * 60_000;
const MAX_SEEN = 2_000;
const COMMENT_CHARS = 1_200;
const MAX_COMMENTS = 8;

export interface WatchMemory {
  on: boolean;
  startedAt: number;
  /** Comments already seen (the first look marks the ones already there). */
  seen: string[];
  baselined: boolean;
  commentWakes: number;
  /** The failure last reported (commit + check names), so the same one isn't reported twice. */
  failingKey: string | null;
  conflicting: boolean;
  checksSeen: boolean;
  noChecksNoted: boolean;
  capNoted: boolean;
  /** The user was told that a comment from someone else was left out. */
  outsiderNoted: boolean;
}

export const watchOff = (): WatchMemory => ({
  on: false,
  startedAt: 0,
  seen: [],
  baselined: false,
  commentWakes: 0,
  failingKey: null,
  conflicting: false,
  checksSeen: false,
  noChecksNoted: false,
  capNoted: false,
  outsiderNoted: false,
});

export interface WatchStep {
  memory: WatchMemory;
  /** A message for the agent, when something needs it. */
  wake?: string;
  /** Something to tell the user only. */
  notice?: string;
}

/** One look at the pull request: what to remember, and whether to wake the agent. Pure. */
export function watchStep(memory: WatchMemory, snap: WatchSnapshot, now: number, baseBranch: string): WatchStep {
  const m: WatchMemory = { ...memory, seen: [...memory.seen] };
  const pr = `pull request #${snap.number}`;
  if (snap.state !== "open") {
    return { memory: { ...watchOff() }, notice: `The ${pr} was ${snap.state}, so LemonLime stopped watching it.` };
  }
  const notices: string[] = [];
  if (snap.checks !== "none") m.checksSeen = true;
  if (!m.checksSeen && !m.noChecksNoted && now - m.startedAt >= NO_CHECKS_AFTER_MS) {
    m.noChecksNoted = true;
    notices.push(`No checks have shown up on ${pr} in 15 minutes. LemonLime keeps watching it for comments and merge conflicts.`);
  }

  const reasons: string[] = [];
  if (snap.checks === "failing") {
    const key = `${snap.headSha}:${snap.failing.join(",")}`;
    if (key !== m.failingKey) {
      const names = snap.failing.length ? snap.failing.join(", ") : "some checks";
      reasons.push(
        `These checks failed: ${names}. Find out why (\`gh pr checks ${snap.number}\`, and \`gh run view --log-failed\` for GitHub Actions), fix it, and push.`,
      );
    }
    m.failingKey = key;
  } else m.failingKey = null;

  if (snap.conflicting && !m.conflicting)
    reasons.push(`The branch now has merge conflicts with ${baseBranch}. Merge ${baseBranch} into it, resolve the conflicts, run the tests, and push.`);
  m.conflicting = snap.conflicting;

  const seen = new Set(m.seen);
  const fresh = snap.comments.filter(c => !seen.has(c.id));
  for (const c of fresh) m.seen.push(c.id);
  if (m.seen.length > MAX_SEEN) m.seen = m.seen.slice(-MAX_SEEN);
  let comments = m.baselined ? fresh.filter(c => c.trusted) : [];
  if (m.baselined && !m.outsiderNoted && fresh.some(c => !c.trusted)) {
    m.outsiderNoted = true;
    notices.push(
      `Someone who can't push to the repository commented on ${pr}. LemonLime doesn't pass comments like that on to the agent; you can read them on GitHub.`,
    );
  }
  m.baselined = true;
  if (comments.length && !reasons.length) {
    // Comments alone: counted, up to the limit.
    if (m.commentWakes >= MAX_COMMENT_WAKES) {
      if (!m.capNoted) {
        m.capNoted = true;
        notices.push(
          `New comments arrived on ${pr}, but they've woken the agent ${MAX_COMMENT_WAKES} times already, so LemonLime stopped waking it for comments. Checks and merge conflicts still wake it.`,
        );
      }
      comments = [];
    } else m.commentWakes += 1;
  }
  if (comments.length) {
    const shown = comments.slice(-MAX_COMMENTS).map(c => {
      const body = c.body.trim().length > COMMENT_CHARS ? `${c.body.trim().slice(0, COMMENT_CHARS)}…` : c.body.trim();
      const quoted = body
        .split("\n")
        .map(l => `> ${l}`)
        .join("\n");
      return `${c.author}${c.path ? ` on ${c.path}` : ""}:\n${quoted}`;
    });
    const more =
      comments.length > MAX_COMMENTS ? `\n\n(${comments.length - MAX_COMMENTS} earlier ones left out; see \`gh pr view ${snap.number} --comments\`.)` : "";
    reasons.push(
      `New comments:\n\n${shown.join("\n\n")}${more}\n\nDo what they ask when it makes sense, and say what you did and didn't do. Don't reply on GitHub unless asked to.`,
    );
  }

  const step: WatchStep = { memory: m };
  if (notices.length) step.notice = notices.join(" ");
  if (reasons.length)
    step.wake = `(LemonLime is watching ${pr} for you.) ${reasons.length > 1 ? "A few things changed:" : "Something changed:"}\n\n${reasons.map(r => `- ${r.replace(/\n/g, "\n  ")}`).join("\n")}`;
  return step;
}

export interface WatcherOptions {
  /** Where the watch is saved, so it carries on after a restart. null keeps it in memory. */
  file: string | null;
  snapshot: () => Promise<WatchSnapshot | null>;
  wake: (text: string, id: string) => void;
  notice: (text: string) => void;
  baseBranch: string;
  everyMs?: number;
  now?: () => number;
}

/** The pull request watch for one thread: on or off, saved, ticking while on. */
export class PullRequestWatcher {
  private memory: WatchMemory;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private wakes = 0;

  constructor(private readonly o: WatcherOptions) {
    this.memory = this.load();
    if (this.memory.on) this.startTimer();
  }

  get state(): PullRequestWatchState {
    return { on: this.memory.on, commentWakes: this.memory.commentWakes, maxCommentWakes: MAX_COMMENT_WAKES };
  }

  /** Turn the watch on (from a clean slate) or off. */
  set(on: boolean): PullRequestWatchState {
    if (on === this.memory.on) return this.state;
    this.memory = on ? { ...watchOff(), on: true, startedAt: this.now() } : watchOff();
    this.save();
    if (on) {
      this.startTimer();
      // The first look marks the comments already there and reports checks already failing.
      void this.tick();
    } else this.stop();
    return this.state;
  }

  /** Look once. While a look is under way, waits for that one instead. */
  tick(): Promise<void> {
    if (!this.memory.on) return Promise.resolve();
    this.inflight ??= this.look().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async look(): Promise<void> {
    const snap = await this.o.snapshot().catch(() => null);
    if (!snap || !this.memory.on) return;
    const step = watchStep(this.memory, snap, this.now(), this.o.baseBranch);
    this.memory = step.memory;
    this.save();
    if (step.notice) this.o.notice(step.notice);
    if (step.wake) this.o.wake(step.wake, `pr-watch-${snap.number}-${this.now()}-${++this.wakes}`);
    if (!this.memory.on) this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? WATCH_EVERY_MS);
    this.timer.unref?.();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private load(): WatchMemory {
    if (!this.o.file || !existsSync(this.o.file)) return watchOff();
    try {
      return { ...watchOff(), ...(JSON.parse(readFileSync(this.o.file, "utf8")) as Partial<WatchMemory>) };
    } catch {
      return watchOff();
    }
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeFileSync(this.o.file, JSON.stringify(this.memory));
    } catch {
      /* the watch still works for this run */
    }
  }
}
