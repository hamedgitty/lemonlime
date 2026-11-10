import { shortPath, withoutRewound, type SubagentInfo, type ThreadEvent } from "@lemonlime/protocol";
import type { FoldedSteps, TimelineItem } from "./timeline.ts";
import { commandOf } from "./timelineView.ts";

/**
 * The agent's working steps as the timeline shows them: one plain-English line per tool
 * call ("Read src/app.tsx", "Ran pnpm test"), runs of the same kind of step folded into one
 * line ("Read 6 files"), subagents picked out, and how far apart rows sit.
 */

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export type StepKind =
  "read" | "edit" | "write" | "command" | "search" | "files" | "list" | "fetch" | "web" | "todo" | "background" | "subagent" | "question" | "tool";

export interface StepLabel {
  kind: StepKind;
  /** What it did, in the past tense ("Read", "Searched for"). */
  verb: string;
  /** The same while it runs ("Reading", "Searching for"). */
  doing: string;
  /** What it did it to: a path, command, query or host. May be empty. */
  target: string;
  /** The target is code (a path, command or tool name) and shows in the code font. */
  code: boolean;
  /** Quieter words after the target, when there's more worth saying. */
  detail?: string;
  /** The whole target (a full path or URL, the command's every line), for a tooltip. */
  full?: string;
  /** The tool's own name without any server prefix (groups unknown tools by name). */
  tool: string;
}

const READ = new Set(["read", "read_file", "view", "view_file", "cat", "open_file", "notebookread", "read_notebook"]);
const EDIT = new Set([
  "edit",
  "multiedit",
  "multi_edit",
  "edit_file",
  "edit_files",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "apply_patch",
  "patch",
  "replace",
  "notebookedit",
  "edit_notebook",
]);
const WRITE = new Set(["write", "write_file", "create_file", "create"]);
const SEARCH = new Set(["grep", "search", "ripgrep", "rg", "grep_search", "codebase_search", "search_files", "find_in_files"]);
const FILES = new Set(["glob", "find", "find_files", "file_search"]);
const LIST = new Set(["ls", "list", "list_dir", "list_directory", "list_files"]);
const FETCH = new Set(["webfetch", "web_fetch", "fetch", "fetch_url", "read_url"]);
const WEB = new Set(["websearch", "web_search", "search_web"]);
const TODO = new Set(["todowrite", "todo_write", "todoread", "todo_read", "update_plan", "update_todos"]);
const SUBAGENT = new Set(["task", "agent", "spawn_subagent"]);
const BACKGROUND_OUTPUT = new Set(["bashoutput", "taskoutput"]);
const BACKGROUND_STOP = new Set(["killshell", "killbash"]);

/** A tool's own name, without the `mcp__server__` (Claude Code) or `server.` (Codex) part. */
export function toolName(name: string): { tool: string; server: string | null } {
  const n = name.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n);
  if (mcp) return { tool: mcp[2]!, server: mcp[1]! };
  const dotted = /^([A-Za-z][\w-]*)\.([A-Za-z][\w-]*)$/.exec(n);
  if (dotted) return { tool: dotted[2]!, server: dotted[1]! };
  return { tool: n, server: null };
}

const keyOf = (tool: string) => tool.toLowerCase().replace(/[\s-]+/g, "_");

const str = (input: unknown, ...keys: string[]): string | null => {
  if (!input || typeof input !== "object") return null;
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

const firstLine = (s: string) =>
  s
    .split("\n")
    .find(l => l.trim())
    ?.trim() ?? "";
const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path", "absolute_path", "target_file", "filename", "file"];
/**
 * A path as it reads inside the project: the part after the thread's own folder (a local
 * thread's worktree under ~/.lemonlime/worktrees, a cloud sandbox's workspace), shortened
 * from the left when it's still long.
 */
export function projectPath(p: string): string {
  const path = p.replace(/\/+$/, "");
  const inside = /\/\.lemonlime\/worktrees\/[^/]+\/[^/]+\/(.+)$/.exec(path) ?? /^\/(?:[^/]+\/)*workspace\/(.+)$/.exec(path);
  return shortPath(inside ? inside[1]! : path, 44);
}
const showPath = projectPath;

/** Files named in an edit that changes several at once (Codex's file changes, a patch). */
function editedPaths(input: unknown): string[] {
  if (input && typeof input === "object") {
    const changes = (input as { changes?: unknown }).changes;
    if (Array.isArray(changes)) return changes.flatMap(c => (typeof (c as { path?: unknown })?.path === "string" ? [(c as { path: string }).path] : []));
  }
  const patch = typeof input === "string" ? input : str(input, "input", "patch");
  if (!patch) return [];
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1]!.trim());
}

/** "docs.example.com/guide" from a URL (the host alone when the rest is long). */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = (u.pathname + u.search).replace(/\/$/, "");
    const host = u.host.replace(/^www\./, "");
    return rest && host.length + rest.length <= 48 ? host + rest : host;
  } catch {
    return url.length > 48 ? `${url.slice(0, 47)}…` : url;
  }
}

const quoted = (s: string) => {
  const one = firstLine(s);
  return `“${one.length > 60 ? `${one.slice(0, 59)}…` : one}”`;
};

/** One tool call as a plain-English line: what it did and to what. */
export function describeStep(name: string, input: unknown): StepLabel {
  const { tool, server } = toolName(name);
  const key = keyOf(tool);
  const base = { tool, code: false };

  if (SUBAGENT.has(key)) {
    const task = subagentTask(input);
    return { ...base, kind: "subagent", verb: "Subagent", doing: "Subagent", target: task };
  }
  const command = commandOf(tool, input) ?? (key === "execute" ? str(input, "command") : null);
  if (command) {
    const background = (input as { run_in_background?: unknown } | null)?.run_in_background === true;
    const desc = str(input, "description");
    return {
      ...base,
      kind: "command",
      verb: background ? "Started" : "Ran",
      doing: background ? "Starting" : "Running",
      target: firstLine(command),
      code: true,
      full: command,
      ...(background ? { detail: "in the background" } : desc && desc !== firstLine(command) ? { detail: desc } : {}),
    };
  }
  const path = str(input, ...PATH_KEYS);
  if (READ.has(key))
    return {
      ...base,
      kind: "read",
      verb: "Read",
      doing: "Reading",
      target: path ? showPath(path) : "a file",
      code: Boolean(path),
      ...(path ? { full: path } : {}),
    };
  if (EDIT.has(key) || WRITE.has(key)) {
    const paths = path ? [path] : editedPaths(input);
    const write = WRITE.has(key);
    const verb = write ? "Wrote" : "Edited";
    const doing = write ? "Writing" : "Editing";
    const kind = write ? "write" : "edit";
    if (!paths.length) return { ...base, kind, verb, doing, target: write ? "a file" : "files" };
    return {
      ...base,
      kind,
      verb,
      doing,
      target: showPath(paths[0]!),
      code: true,
      full: paths.join("\n"),
      ...(paths.length > 1 ? { detail: `and ${paths.length - 1} more` } : {}),
    };
  }
  if (SEARCH.has(key)) {
    const q = str(input, "pattern", "query", "regex", "search");
    const where = str(input, "path", "glob", "include");
    return {
      ...base,
      kind: "search",
      verb: "Searched for",
      doing: "Searching for",
      target: q ? quoted(q) : "text",
      ...(q ? { full: q } : {}),
      ...(where ? { detail: `in ${showPath(where)}` } : {}),
    };
  }
  if (FILES.has(key)) {
    const q = str(input, "pattern", "query", "glob", "name");
    return { ...base, kind: "files", verb: "Looked for files", doing: "Looking for files", target: q ? `named ${firstLine(q)}` : "", code: false };
  }
  if (LIST.has(key))
    return {
      ...base,
      kind: "list",
      verb: "Listed",
      doing: "Listing",
      target: path ? showPath(path) : "the folder",
      code: Boolean(path),
      ...(path ? { full: path } : {}),
    };
  if (FETCH.has(key)) {
    const url = str(input, "url", "uri", "href");
    return { ...base, kind: "fetch", verb: "Fetched", doing: "Fetching", target: url ? shortUrl(url) : "a page", ...(url ? { full: url } : {}) };
  }
  if (WEB.has(key)) {
    const q = str(input, "query", "q", "search");
    return { ...base, kind: "web", verb: "Searched the web", doing: "Searching the web", target: q ? `for ${quoted(q)}` : "", ...(q ? { full: q } : {}) };
  }
  if (TODO.has(key)) return { ...base, kind: "todo", verb: "Updated the to-do list", doing: "Updating the to-do list", target: "" };
  if (BACKGROUND_OUTPUT.has(key))
    return { ...base, kind: "background", verb: "Checked a background command", doing: "Checking a background command", target: "" };
  if (BACKGROUND_STOP.has(key))
    return { ...base, kind: "background", verb: "Stopped a background command", doing: "Stopping a background command", target: "" };
  if (key === "message_subagent") return { ...base, kind: "tool", verb: "Messaged a subagent", doing: "Messaging a subagent", target: "" };
  if (key === "list_subagents") return { ...base, kind: "tool", verb: "Checked on its subagents", doing: "Checking on its subagents", target: "" };
  if (key === "askuserquestion") return { ...base, kind: "question", verb: "Asked you", doing: "Asking you", target: "a question" };
  if (key === "exitplanmode") return { ...base, kind: "tool", verb: "Finished its plan", doing: "Finishing its plan", target: "" };

  const summary = summarizeInput(input);
  // Some agents (over ACP) name a call with a sentence of their own, such as "Read README.md".
  if (/\s/.test(tool) && !server)
    return { ...base, kind: "tool", verb: clip(firstLine(tool)), doing: clip(firstLine(tool)), target: "", ...(summary ? { detail: summary } : {}) };
  return {
    ...base,
    kind: "tool",
    verb: "Used",
    doing: "Using",
    target: tool || "a tool",
    code: true,
    ...(summary || server ? { detail: [summary, server ? `from ${server}` : ""].filter(Boolean).join(" ") } : {}),
  };
}

/** The first short, telling field of an unknown tool's input. */
function summarizeInput(input: unknown): string {
  if (typeof input === "string") return clip(firstLine(input));
  const v = str(input, "command", "cmd", ...PATH_KEYS, "pattern", "query", "url", "description", "name", "title");
  if (!v) return "";
  return PATH_KEYS.some(k => str(input, k) === v) ? showPath(v) : clip(firstLine(v));
}

const clip = (s: string, max = 80) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ─── Folding runs of steps into one line ─────────────────────────────────────

/** Consecutive steps of one kind, shown as one line that opens to each of them. */
export interface StepBundle {
  kind: "bundle";
  key: string;
  step: StepKind;
  items: ToolItem[];
}

/** Kinds that never fold together: each subagent and question deserves its own row. */
const NEVER_BUNDLED = new Set<StepKind>(["subagent", "question"]);

const bundleKey = (it: ToolItem): string | null => {
  const s = describeStep(it.name, it.input);
  if (NEVER_BUNDLED.has(s.kind)) return null;
  return s.kind === "tool" ? `tool:${s.tool}` : s.kind;
};

/** Folds runs of two or more steps of the same kind ("Read 6 files"). Everything else stays as it is. */
export function bundleSteps<T extends { kind: string }>(items: readonly (T | ToolItem)[]): Array<T | ToolItem | StepBundle> {
  const out: Array<T | ToolItem | StepBundle> = [];
  let run: ToolItem[] = [];
  let runKey: string | null = null;
  const flush = () => {
    if (run.length > 1) out.push({ kind: "bundle", key: `bundle:${run[0]!.key}`, step: describeStep(run[0]!.name, run[0]!.input).kind, items: run });
    else out.push(...run);
    run = [];
    runKey = null;
  };
  for (const it of items) {
    const tool = it.kind === "tool" ? (it as ToolItem) : null;
    const key = tool ? bundleKey(tool) : null;
    if (tool && key && key === runKey) {
      run.push(tool);
      continue;
    }
    flush();
    if (tool && key) {
      run = [tool];
      runKey = key;
    } else out.push(it);
  }
  flush();
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 2 ? "twice" : `${n} times`);

/** The bundle's line: "Read 6 files", "Ran 3 commands" (or "Reading 6 files" while the last one runs). */
export function bundleLabel(b: StepBundle, running = false): string {
  const n = b.items.length;
  const labels = b.items.map(i => describeStep(i.name, i.input));
  const distinct = new Set(labels.map(l => l.full ?? l.target)).size;
  const first = labels[0]!;
  const v = (past: string, now: string) => (running ? now : past);
  switch (b.step) {
    case "read":
      return distinct === 1 ? `${v("Read", "Reading")} ${first.target} ${times(n)}` : `${v("Read", "Reading")} ${plural(distinct, "file", "files")}`;
    case "edit":
      return distinct === 1 ? `${v("Edited", "Editing")} ${first.target} ${times(n)}` : `${v("Edited", "Editing")} ${plural(distinct, "file", "files")}`;
    case "write":
      return `${v("Wrote", "Writing")} ${plural(distinct, "file", "files")}`;
    case "command":
      return `${v("Ran", "Running")} ${plural(n, "command", "commands")}`;
    case "search":
      return `${v("Ran", "Running")} ${plural(n, "search", "searches")}`;
    case "files":
      return `${v("Looked for files", "Looking for files")} ${times(n)}`;
    case "list":
      return `${v("Listed", "Listing")} ${plural(distinct, "folder", "folders")}`;
    case "fetch":
      return `${v("Fetched", "Fetching")} ${plural(n, "page", "pages")}`;
    case "web":
      return `${v("Searched the web", "Searching the web")} ${times(n)}`;
    case "todo":
      return `${v("Updated the to-do list", "Updating the to-do list")} ${times(n)}`;
    case "background":
      return `${v("Checked background commands", "Checking background commands")} ${times(n)}`;
    default:
      return `${v("Used", "Using")} ${first.target} ${times(n)}`;
  }
}

/** A quiet list of what the bundle touched: file names, commands, queries. */
export function bundlePreview(b: StepBundle): string {
  const seen = new Set<string>();
  for (const it of b.items) {
    const l = describeStep(it.name, it.input);
    const t = l.code && (b.step === "read" || b.step === "edit" || b.step === "write") ? (l.target.split("/").pop() ?? l.target) : l.target;
    if (t) seen.add(t);
  }
  return [...seen].join(", ");
}

// ─── Subagents ───────────────────────────────────────────────────────────────

export const isSubagentCall = (name: string) => SUBAGENT.has(keyOf(toolName(name).tool));

/** The task a subagent was given, one line (Claude Code's description, else the prompt). */
export function subagentTask(input: unknown): string {
  const t = str(input, "description", "task", "prompt");
  if (!t) return "A task";
  const one = firstLine(t);
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

/** Everything the subagent was told. */
export const subagentPrompt = (input: unknown): string => str(input, "prompt", "task", "description") ?? "";

/** The id of a subagent the runner started, from the spawn tool's reply. */
export function runnerSubagentId(output: unknown): string | null {
  const text =
    typeof output === "string"
      ? output
      : Array.isArray((output as { content?: unknown } | null)?.content)
        ? ((output as { content: { text?: unknown }[] }).content.map(c => (typeof c.text === "string" ? c.text : "")).join("\n") ?? "")
        : JSON.stringify(output ?? "");
  return /Started subagent ([\w-]+)/.exec(text)?.[1] ?? null;
}

/** The runner's subagents as it last listed them, by id. */
export function latestSubagents(all: readonly ThreadEvent[]): Map<string, SubagentInfo> {
  const events = withoutRewound(all);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "subagent_update") return new Map(e.subagents.map(s => [s.id, s]));
  }
  return new Map();
}

export type SubagentState = "running" | "waiting" | "done" | "failed" | "stopped";

const RUNNER_STATE: Record<SubagentInfo["status"], SubagentState> = { working: "running", waiting: "waiting", idle: "done", failed: "failed" };

/**
 * Where a subagent is: from the runner's list for its own subagents, else from the tool
 * call (Claude Code's subagent tool replies when its subagent is done). `live` is whether
 * the turn that started it is still going.
 */
export function subagentState(item: Pick<ToolItem, "result">, info: SubagentInfo | undefined, live: boolean): SubagentState {
  if (item.result?.isError) return "failed";
  if (info) return RUNNER_STATE[info.status];
  if (!item.result) return live ? "running" : "stopped";
  return "done";
}

// ─── Spacing ─────────────────────────────────────────────────────────────────

/** Rows that sit close together: the agent's working steps. */
const STEP_ROWS = new Set(["tool", "bundle", "diff", "reasoning", "approval", "options", "fold"]);

export type RowGap = "none" | "step" | "block" | "turn";

/** How far a row sits below the one before it: steps tight, messages with more air, a new turn most. */
export function rowGap(prev: string | undefined, cur: string): RowGap {
  if (prev === undefined) return "none";
  if (cur === "user" || cur === "auto") return "turn";
  if (STEP_ROWS.has(prev) && STEP_ROWS.has(cur)) return "step";
  // The agent's reply already has its row of buttons under it, which gives it room.
  if (prev === "agent") return "step";
  return "block";
}

/** Anything the timeline lists: an item, a folded turn or a bundle of steps. */
export type ShownRow = TimelineItem | FoldedSteps | StepBundle;
