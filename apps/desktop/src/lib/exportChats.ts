import { ThreadEvent } from "@lemonlime/protocol";
import { AGENT_LABELS, repoName } from "./format.ts";
import type { ThreadSummary } from "./threads.ts";
import { buildTimeline } from "./timeline.ts";

/**
 * Saving conversations to a file. A thread's messages can be in three places: what this app
 * kept from showing the thread, the file the thread's runner keeps on this computer, and (for
 * a cloud thread) the history the control plane stores. The app's own copy goes when storage
 * runs short and was never there for a thread that wasn't opened on this computer, so the
 * export asks the others too and takes whichever has more. A thread whose messages can't be
 * had still goes in the file, with a line saying why they are missing.
 */

export interface ExportSources {
  /** What this app kept from showing the thread; empty when it kept nothing. */
  cached(threadId: string): ThreadEvent[];
  /**
   * The file the thread's runner keeps on this computer, as text (one event per line), or
   * null when there is none. Left out where the file can't be reached (outside the desktop app).
   */
  kept?: ((threadId: string) => Promise<string | null>) | undefined;
  /** The control plane's stored history after `after`, a page at a time. Left out when not signed in. */
  stored?: ((threadId: string, after: number) => Promise<{ events: ThreadEvent[]; more: boolean }>) | undefined;
}

export interface ExportedThread {
  thread: ThreadSummary;
  events: ThreadEvent[];
  /** Why the messages are missing or may not be complete, for the person reading the file. Absent when all of it is there. */
  note?: string;
}

/** Pages of stored history read for one thread before giving up on reaching its end. */
const MAX_PAGES = 200;

/**
 * Reads a runner's history file the way the runner does: one event per line, skipping blank
 * lines and any line that isn't the next event in order (the last line of a file whose
 * writing was cut short).
 */
export function parseHistory(text: string): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const e = ThreadEvent.safeParse(raw);
    if (e.success && e.data.seq === events.length + 1) events.push(e.data);
  }
  return events;
}

const lastSeq = (events: readonly ThreadEvent[]) => events[events.length - 1]?.seq ?? 0;
/** The copy that reaches further into the conversation. */
const fuller = (a: ThreadEvent[], b: ThreadEvent[]) => (lastSeq(b) > lastSeq(a) ? b : a);
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).trim().replace(/[.\s]+$/, "");

/** One thread's messages for the file, from wherever they can be had. Never throws. */
export async function gatherThread(thread: ThreadSummary, src: ExportSources): Promise<ExportedThread> {
  const cached = src.cached(thread.id);
  const out = (events: ThreadEvent[], note?: string): ExportedThread => ({ thread, events, ...(note ? { note } : {}) });

  if (thread.mode === "local") {
    // A thread on another machine keeps its history there; here there is only what the app saw.
    if (thread.machine) {
      return out(
        cached,
        cached.length ? undefined : "This thread runs on another machine and its messages aren't on this computer. Open it, then export again.",
      );
    }
    let kept: ThreadEvent[] = [];
    let problem: string | null = null;
    try {
      const text = await src.kept?.(thread.id);
      if (text) kept = parseHistory(text);
    } catch (err) {
      problem = reason(err);
    }
    const events = fuller(cached, kept);
    if (events.length) return out(events);
    return out(
      [],
      problem ? `This thread's messages couldn't be read from this computer: ${problem}.` : "No messages were found for this thread on this computer.",
    );
  }

  if (!src.stored) {
    return out(
      cached,
      cached.length
        ? "You weren't signed in when this was exported, so this is what this computer had kept. The latest messages may be missing."
        : "This thread's messages aren't on this computer. Sign in, then export again.",
    );
  }
  const stored: ThreadEvent[] = [];
  let problem: string | null = null;
  let cutShort = false;
  try {
    let after = 0;
    for (let page = 0; ; page++) {
      const r = await src.stored(thread.id, after);
      stored.push(...r.events);
      if (!r.more || r.events.length === 0) break;
      if (page + 1 >= MAX_PAGES) {
        cutShort = true;
        break;
      }
      after = lastSeq(r.events);
    }
  } catch (err) {
    problem = reason(err);
  }
  const events = fuller(stored, cached);
  if (problem) {
    return out(
      events,
      events.length
        ? `The rest of this thread couldn't be fetched (${problem}), so this is what this computer had. The latest messages may be missing.`
        : `This thread's messages couldn't be fetched: ${problem}.`,
    );
  }
  if (!events.length) return out([], "No messages are stored for this thread yet.");
  // The app's own copy reaching past the stored one means it has the whole conversation.
  return out(events, cutShort && events === stored ? "This thread is too long to fetch in one go, so its latest messages are missing." : undefined);
}

/** Every picked thread, in order. One thread's trouble never stops the others. */
export async function gatherThreads(threads: readonly ThreadSummary[], src: ExportSources): Promise<ExportedThread[]> {
  const out: ExportedThread[] = [];
  for (const t of threads) out.push(await gatherThread(t, src));
  return out;
}

/** How many threads went into the file without their messages, and how many may lack some. */
export function exportGaps(threads: readonly ExportedThread[]): { empty: number; partial: number } {
  return {
    empty: threads.filter(t => t.events.length === 0).length,
    partial: threads.filter(t => t.events.length > 0 && t.note !== undefined).length,
  };
}

/** What to tell the person after saving, or null when every thread is in the file whole. */
export function exportGapsLine(threads: readonly ExportedThread[]): string | null {
  const { empty, partial } = exportGaps(threads);
  const lines: string[] = [];
  if (empty === 1) lines.push(threads.length === 1 ? "This thread is in the file without its messages." : "1 thread is in the file without its messages.");
  else if (empty > 1) lines.push(`${empty} threads are in the file without their messages.`);
  if (partial === 1) lines.push(threads.length === 1 ? "This thread may be missing its latest messages." : "1 thread may be missing its latest messages.");
  else if (partial > 1) lines.push(`${partial} threads may be missing their latest messages.`);
  if (!lines.length) return null;
  return `${lines.join(" ")} The file says why${empty + partial > 1 ? " for each" : ""}.`;
}

/** The file for tools: everything that was gathered, as it is. */
export function toJson(threads: readonly ExportedThread[], exportedAt: string): string {
  return JSON.stringify({ exportedAt, threads }, null, 2);
}

/**
 * Who a message a person typed is put down to. Events don't say which workspace member wrote
 * a message, so only a thread nobody else can direct is certain to be all yours.
 */
export function personLabel(thread: Pick<ThreadSummary, "sharing">): string {
  if (!thread.sharing) return "You";
  return thread.sharing === "read-only" ? "A workspace member" : "You or a workspace member";
}

/**
 * The file for reading: each thread as the app shows it (streamed replies joined, messages
 * taken back by a rewind left out), with what a person typed kept apart from what a subagent
 * or LemonLime sent by itself.
 */
export function toMarkdown(threads: readonly ExportedThread[], o: { exportedAt: string; when?: (iso: string) => string }): string {
  const when = o.when ?? ((iso: string) => new Date(iso).toLocaleString());
  const parts: string[] = [`# LemonLime chats\n\nExported ${when(o.exportedAt)}.\n`];
  for (const { thread: t, events, note } of threads) {
    const agent = AGENT_LABELS[t.agent.kind];
    const person = personLabel(t);
    parts.push(`\n---\n\n## ${t.title}\n\n${agent}, ${repoName(t.repo)}, branch \`${t.branch}\`, ${t.mode === "cloud" ? "cloud" : "this computer"}.\n`);
    if (note) parts.push(`\n> ${note}\n`);
    for (const it of buildTimeline(events)) {
      if (it.kind === "user") parts.push(`\n**${person}** (${when(it.at)})\n\n${it.text}\n`);
      else if (it.kind === "auto" && it.from === "subagent") parts.push(`\n**Subagent report** (${when(it.at)})\n\n${it.text}\n`);
      else if (it.kind === "auto") parts.push(`\n> Sent by LemonLime (${when(it.at)}): ${it.text.trim().replace(/\s*\n\s*/g, " ")}\n`);
      else if (it.kind === "agent") parts.push(`\n**${agent}**\n\n${it.text}\n`);
      else if (it.kind === "tool") parts.push(`\n> Used ${it.name}\n`);
      else if (it.kind === "error") parts.push(`\n> Error: ${it.message}\n`);
    }
  }
  return parts.join("");
}
