import type { ThreadEvent } from "@lemonlime/protocol";
import type { TimelineItem } from "./timeline.ts";

/**
 * What the buttons on a message do that needs working out: forking the conversation into
 * a new thread (with a note that carries it over), and editing a message you sent.
 */

// ─── Fork into a new thread ──────────────────────────────────────────────────

/** Most characters of one message in the note, and of the whole note. */
const MESSAGE_CHARS = 2_500;
const NOTE_CHARS = 16_000;
const MAX_FILES = 40;

const cut = (text: string, max: number) => {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export interface ForkFrom {
  /** The timeline key of the message the fork starts after. */
  key: string;
  /** Text the user selected in that message to fork from. */
  quote?: string | undefined;
}

export interface ForkSource {
  /** The thread being forked. */
  title: string;
  branch: string;
  /** Where the new thread's files start from. */
  baseBranch: string;
}

/**
 * The first message of a forked thread: the conversation up to (and including) the
 * message it was forked from, the files the earlier thread changed by then, and what to
 * do next. Built from the timeline only; long conversations keep their first message and
 * as many of the latest as fit. Null when the message isn't in the timeline.
 */
export function forkNote(items: readonly TimelineItem[], from: ForkFrom, source: ForkSource): string | null {
  const end = items.findIndex(it => it.key === from.key);
  if (end < 0) return null;
  const upTo = items.slice(0, end + 1);
  const last = upTo[end]!;
  const turns: string[] = [];
  for (const it of upTo) {
    if (it.kind === "user" && !it.pending && it.text.trim()) turns.push(`**User:**\n\n${cut(it.text, MESSAGE_CHARS)}`);
    else if (it.kind === "agent" && it.text.trim()) turns.push(`**Agent:**\n\n${cut(it.text, MESSAGE_CHARS)}`);
  }
  const files = new Map<string, string>();
  for (const it of upTo) if (it.kind === "diff") files.set(it.path, it.change);

  const head = `(Forked in LemonLime from the thread “${source.title}”. This is a new conversation that carries on from the point below. Its files start from ${source.baseBranch}; the earlier thread's changes are on its branch ${source.branch}, not here, unless you bring them over with git.)`;
  const fileList = files.size
    ? `## Files the earlier thread had changed by then\n\n${[...files]
        .slice(0, MAX_FILES)
        .map(([p, c]) => `- ${p} (${c})`)
        .join("\n")}${files.size > MAX_FILES ? `\n- …and ${files.size - MAX_FILES} more` : ""}`
    : "";
  const next = [
    from.quote?.trim() ? `The user forked from this part of the last message:\n\n${quoteBlock(from.quote)}\n` : "",
    last.kind === "user"
      ? "Pick up from the user's last message above."
      : "Say in a sentence that you have the context, then wait for what the user wants next. Don't change any files yet.",
  ]
    .filter(Boolean)
    .join("\n");

  const build = (shown: string[], left: number) =>
    [
      head,
      `## The conversation so far\n\n${left ? `${shown[0]}\n\n(${left} messages in between left out)\n\n${shown.slice(1).join("\n\n")}` : shown.join("\n\n")}`,
      fileList,
      `## Next\n\n${next}`,
    ]
      .filter(Boolean)
      .join("\n\n");

  let shown = turns;
  let left = 0;
  let note = build(shown, left);
  // Drop the oldest messages after the first until it fits.
  while (note.length > NOTE_CHARS && shown.length > 2) {
    shown = [shown[0]!, ...shown.slice(2)];
    left += 1;
    note = build(shown, left);
  }
  return note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS)}…` : note;
}

const quoteBlock = (text: string) =>
  text
    .trim()
    .split("\n")
    .map(l => `> ${l}`)
    .join("\n");

/** The forked thread's name. */
export function forkTitle(title: string): string {
  const t = title.trim() || "Thread";
  return t.endsWith("(fork)") ? t : `${t} (fork)`.slice(0, 200);
}

// ─── Edit a message you sent ─────────────────────────────────────────────────

export interface EditDraft {
  /** The message being edited. */
  seq: number;
  key: string;
  at: string;
  text: string;
  /** Sending replaces that message and everything after it (a rewind); otherwise it goes as a new message. */
  replace: boolean;
  /** Whether replacing is possible here (the thread can go back to that message). */
  canReplace: boolean;
}

/** Start editing a sent message: it replaces history from there when the thread can go back to it. */
export function startEdit(item: Extract<TimelineItem, { kind: "user" }>, canReplace: boolean): EditDraft | null {
  if (item.seq === null || item.pending) return null;
  return { seq: item.seq, key: item.key, at: item.at, text: item.text, replace: canReplace, canReplace };
}

/** What sending the edited text does: go back to the message first, or just send. */
export function editSendPlan(draft: EditDraft | null, live: boolean): { rewindTo: number } | { send: true } {
  return draft?.replace && draft.canReplace && live ? { rewindTo: draft.seq } : { send: true };
}

/** The runner has gone back to `seq` since `afterSeq` (so the edited message can go). */
export function rewindLanded(events: readonly ThreadEvent[], seq: number, afterSeq: number): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq <= afterSeq) return false;
    if (e.type === "rewind" && e.toSeq === seq) return true;
  }
  return false;
}
