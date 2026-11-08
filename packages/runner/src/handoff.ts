import { withoutRewound, type ThreadEvent } from "@lemonlime/protocol";

/** Most characters of a handoff note; the agent reads the rest from the files and git. */
const HANDOFF_CHARS = 16_000;
const ASK_CHARS = 4_000;
const LAST_CHARS = 3_000;
const MAX_FILES = 60;
const MAX_LATER_ASKS = 6;
const MAX_STEPS = 12;

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", acp: "another agent" };

function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function oneLine(text: string, max = 200): string {
  return cut(text.replace(/\s+/g, " "), max);
}

/**
 * The note a new agent conversation starts from when a thread moves to another agent (or
 * to an account its conversation couldn't be carried to): what the user asked for, what
 * was done, which files changed, and where things stood. Built from the thread's history
 * only (what was said, the to-do list, file changes); the agent can read the files and git
 * log for detail.
 */
export function buildHandoff(events: readonly ThreadEvent[], opts: { from: string; reason?: string }): string {
  const shown = withoutRewound(events);
  const asks = shown.filter((e): e is Extract<ThreadEvent, { type: "user_message" }> => e.type === "user_message" && !e.clientMsgId?.startsWith("auto-"));
  const replies = shown.filter((e): e is Extract<ThreadEvent, { type: "agent_message" }> => e.type === "agent_message" && !e.partial && e.text.trim() !== "");
  const files = new Map<string, string>();
  for (const e of shown) if (e.type === "file_diff") files.set(e.path, e.change);
  let todos: Extract<ThreadEvent, { type: "todo_snapshot" }>["items"] = [];
  for (const e of shown) if (e.type === "todo_snapshot") todos = e.items;
  const steps = shown.filter(e => e.type === "tool_call").length;

  const from = AGENT_NAMES[opts.from] ?? opts.from;
  const lines: string[] = [];
  lines.push(
    `(Handoff from LemonLime: this thread was being worked on by ${from}${opts.reason ? `, which stopped because ${opts.reason}` : ""}. You are taking over in the same working folder and git branch; its changes so far are already there. Here is what happened.)`,
  );

  const first = asks[0];
  lines.push(`## What the user asked for\n\n${first ? cut(first.text, ASK_CHARS) : "(No message from the user yet.)"}`);
  const later = asks.slice(1);
  if (later.length) {
    const recent = later.slice(-MAX_LATER_ASKS);
    lines.push(
      `## What they said after that\n\n${later.length > recent.length ? `(${later.length - recent.length} earlier messages left out)\n` : ""}${recent.map(m => `- ${oneLine(m.text, 400)}`).join("\n")}`,
    );
  }

  const done = replies.slice(0, -1).slice(-MAX_STEPS);
  const doneLines = done.map(r => `- ${oneLine(r.text)}`);
  if (steps) doneLines.unshift(`- ${steps} tool call${steps === 1 ? "" : "s"} (commands, reads and edits) so far.`);
  if (todos.length)
    doneLines.push(
      ...todos.map(t => `- [${t.status === "completed" ? "x" : " "}] ${oneLine(t.text, 160)}${t.status === "in_progress" ? " (was in progress)" : ""}`),
    );
  if (doneLines.length) lines.push(`## What was done\n\n${doneLines.join("\n")}`);

  if (files.size) {
    const list = [...files.entries()].slice(0, MAX_FILES).map(([path, change]) => `- ${path} (${change})`);
    if (files.size > MAX_FILES) list.push(`- …and ${files.size - MAX_FILES} more (see \`git log\` on this branch)`);
    lines.push(`## Files changed\n\n${list.join("\n")}`);
  } else lines.push("## Files changed\n\nNone recorded yet. Check `git status` and `git log` to be sure.");

  const last = replies.at(-1);
  lines.push(`## Where it stopped\n\n${last ? `${from}'s last message:\n\n${cut(last.text, LAST_CHARS)}` : `${from} hadn't replied yet.`}`);

  lines.push(
    "Carry on with the task from here. Check the files and `git log` before redoing anything, don't undo the work above unless it's wrong, and tell the user briefly what you're picking up.",
  );
  let note = lines.join("\n\n");
  if (note.length > HANDOFF_CHARS) note = `${note.slice(0, HANDOFF_CHARS)}…`;
  return note;
}
