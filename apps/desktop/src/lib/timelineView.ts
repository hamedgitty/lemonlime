import type { FoldedSteps, TimelineItem } from "./timeline.ts";

/**
 * Small pure helpers behind the thread view: folding long messages, the message list on the
 * right edge, shell command output, the "New" divider and the live turn clock.
 */

// ─── Long messages ───────────────────────────────────────────────────────────

export interface Collapsed {
  head: string;
  tail: string;
  /** Lines left out between head and tail (0 when cut by length inside long lines). */
  hiddenLines: number;
  /** Characters left out. */
  hiddenChars: number;
}

export interface CollapseOptions {
  /** More lines than this collapses. */
  maxLines?: number;
  headLines?: number;
  tailLines?: number;
  /** More characters than this collapses (for text with few, long lines). */
  maxChars?: number;
  headChars?: number;
  tailChars?: number;
}

/**
 * The start and end of a long message, or null when it's short enough to show whole.
 * Cuts at line breaks when there are many lines, otherwise at spaces near the limits.
 * Only collapses when it would hide a good amount, so "Show all" is never for one line.
 */
export function collapseLongText(text: string, o: CollapseOptions = {}): Collapsed | null {
  const { maxLines = 16, headLines = 8, tailLines = 3, maxChars = 1800, headChars = 700, tailChars = 240 } = o;
  const lines = text.split("\n");
  if (lines.length > maxLines && lines.length - headLines - tailLines >= 3) {
    const head = lines.slice(0, headLines).join("\n");
    const tail = lines.slice(lines.length - tailLines).join("\n");
    return { head, tail, hiddenLines: lines.length - headLines - tailLines, hiddenChars: text.length - head.length - tail.length - 2 };
  }
  if (text.length > maxChars) {
    let end = text.lastIndexOf(" ", headChars);
    if (end < headChars * 0.6) end = headChars;
    let start = text.indexOf(" ", text.length - tailChars);
    if (start < 0 || start > text.length - tailChars * 0.6) start = text.length - tailChars;
    const head = text.slice(0, end).trimEnd();
    const tail = text.slice(start).trimStart();
    const hiddenLines = text.slice(end, start).split("\n").length - 1;
    return { head, tail, hiddenLines, hiddenChars: Math.max(0, start - end) };
  }
  return null;
}

// ─── The message list (right-edge rail) ──────────────────────────────────────

export interface TocEntry {
  key: string;
  /** First line of the message, cleaned of Markdown marks. */
  label: string;
  at: string;
}

export interface Toc {
  you: TocEntry[];
  /** The agent's last message in each turn: its answer. */
  agent: TocEntry[];
}

/** First meaningful line, without Markdown heading, list, quote or emphasis marks. */
export function tocLabel(text: string, max = 90): string {
  const line =
    text
      .split("\n")
      .map(l => l.trim())
      .find(l => l && !/^(```|~~~|---+$|\|)/.test(l)) ?? "";
  const clean = line
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
    .replace(/[*_`]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** What the rail lists: every message the user sent, and the agent's answer to each. */
export function tocEntries(items: readonly TimelineItem[]): Toc {
  const you: TocEntry[] = [];
  const agent: TocEntry[] = [];
  let lastAgent: TocEntry | null = null;
  const endTurn = () => {
    if (lastAgent) agent.push(lastAgent);
    lastAgent = null;
  };
  for (const it of items) {
    if (it.kind === "user") {
      if (it.pending) continue;
      endTurn();
      you.push({ key: it.key, label: tocLabel(it.text) || "(no text)", at: it.at });
    } else if (it.kind === "agent" && it.text.trim()) {
      lastAgent = { key: it.key, label: tocLabel(it.text) || "(no text)", at: it.at };
    }
  }
  endTurn();
  return { you, agent };
}

/** The rail shows for threads with at least this many sent messages. */
export const TOC_MIN_MESSAGES = 3;

// ─── Shell commands ──────────────────────────────────────────────────────────

const COMMAND_NAMES = /^(bash|shell|execute|exec_command|run_command|run|terminal|local_shell)$/i;

/**
 * The command a shell tool call ran, or null for other tools. `bash -lc '…'` wrappers
 * (how Codex reports commands) are unwrapped to what the agent actually asked for.
 */
export function commandOf(name: string, input: unknown): string | null {
  if (!COMMAND_NAMES.test(name.trim())) return null;
  const o = typeof input === "string" ? { command: input } : ((input ?? {}) as Record<string, unknown>);
  const raw = o.command ?? o.cmd;
  const command = Array.isArray(raw) ? raw.map(String).join(" ") : typeof raw === "string" ? raw : null;
  if (!command?.trim()) return null;
  return unwrapShell(command.trim());
}

function unwrapShell(command: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command);
  if (!m) return command;
  const body = m[2]!;
  return m[1] === "'" ? body.replace(/'\\''/g, "'") : body.replace(/\\(["\\$`])/g, "$1");
}

// oxlint-disable-next-line no-control-regex -- terminal escape codes are exactly what is removed
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Terminal colour and cursor codes removed, and carriage-return progress lines settled. */
export function cleanTerminalText(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
    .join("\n");
}

export interface CommandOutput {
  text: string;
  /** Known exit code, or null. */
  exitCode: number | null;
}

/**
 * A command's output for the terminal block: the exit code from the event when the agent
 * reported one, else from Claude Code's "Exit code N" first line (which is then dropped).
 */
export function commandOutput(output: unknown, exitCode?: number): CommandOutput {
  let text = typeof output === "string" ? output : output === null || output === undefined ? "" : JSON.stringify(output, null, 2);
  let code = typeof exitCode === "number" ? exitCode : null;
  const m = /^Exit code (-?\d+)\r?\n?/.exec(text);
  if (m) {
    code ??= Number(m[1]);
    text = text.slice(m[0].length);
  }
  return { text: cleanTerminalText(text).replace(/\n+$/, ""), exitCode: code };
}

/** Long output shows its last lines; earlier ones open on request. */
export function terminalTail(text: string, maxLines = 24): { shown: string; hiddenLines: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines + 4) return { shown: text, hiddenLines: 0 };
  return { shown: lines.slice(lines.length - maxLines).join("\n"), hiddenLines: lines.length - maxLines };
}

// ─── "New" divider and the live clock ────────────────────────────────────────

/** A row that stands for several items (a folded turn, a bundle of steps). */
type GroupRow = { kind: string; key: string; items: readonly TimelineItem[] };

const seqOf = (it: TimelineItem | FoldedSteps | GroupRow): number | null => ("items" in it ? (it.items[0]?.seq ?? null) : it.seq);

/**
 * Where the "New" divider goes: before the first item that arrived after `seenSeq`, the
 * last seq the user had seen. -1 for none (nothing new, never seen, or all of it is new).
 */
export function unreadIndex(shown: readonly (TimelineItem | FoldedSteps | GroupRow)[], seenSeq: number | null | undefined): number {
  if (seenSeq === null || seenSeq === undefined) return -1;
  const i = shown.findIndex(it => {
    const seq = seqOf(it);
    return seq !== null && seq > seenSeq;
  });
  return i > 0 ? i : -1;
}

/** When the turn now running began: the latest message the runner has started on. */
export function liveTurnStart(items: readonly TimelineItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "user" && !it.pending) return it.at;
  }
  return null;
}
