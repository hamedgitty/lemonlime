import type { ThreadEvent } from "@lemonlime/protocol";

/**
 * The one menu of things you can do to a thread. The same items, in the same order, show
 * from the sidebar row's ⋯, a right-click on the row, and the thread header's ⋯; each place
 * offers what it can do (the header can compact and move a live thread, the sidebar can't).
 */

export type ThreadMenuId =
  "rename" | "pin" | "unread" | "split" | "fork" | "copy-name" | "copy-branch" | "open-folder" | "pull-request" | "compact" | "move" | "archive" | "remove";

export interface ThreadMenuInput {
  mode: "local" | "cloud";
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  /** Already showing in the split view. */
  inSplit?: boolean;
  /** The actions this place can do (a handler is there for them). Copying is always possible. */
  can: ReadonlySet<ThreadMenuId>;
  /** The thread's pull request: one to view, one that can be opened, or neither. */
  pullRequest?: "view" | "open" | null;
  /** Folders open in an editor (Settings → General), rather than the file manager. */
  editor?: boolean;
  /** Actions shown but not usable right now, with why (shown as the item's hint; "" for none). */
  disabled?: Partial<Record<ThreadMenuId, string>>;
}

export interface ThreadMenuEntry {
  id: ThreadMenuId;
  label: string;
  disabled?: boolean;
  hint?: string;
  /** Removes something: shown last, on its own. */
  danger?: boolean;
}

/** The menu's items in groups (a separator between each); empty groups are left out. */
export function threadMenuGroups(i: ThreadMenuInput): ThreadMenuEntry[][] {
  const has = (id: ThreadMenuId) => id === "copy-name" || id === "copy-branch" || i.can.has(id);
  const live = !i.archived;
  const entry = (id: ThreadMenuId, label: string, extra: Partial<ThreadMenuEntry> = {}): ThreadMenuEntry => {
    const why = i.disabled?.[id];
    return { id, label, ...extra, ...(why !== undefined ? { disabled: true, ...(why ? { hint: why } : {}) } : {}) };
  };
  const groups: (ThreadMenuEntry | false)[][] = [
    [
      has("rename") && entry("rename", "Rename"),
      live && has("pin") && entry("pin", i.pinned ? "Unpin" : "Pin to top"),
      live && has("unread") && entry("unread", i.unread ? "Mark as read" : "Mark as unread"),
    ],
    [live && has("split") && !i.inSplit && entry("split", "Open in split"), has("fork") && entry("fork", "Fork into new thread")],
    [entry("copy-name", "Copy name"), entry("copy-branch", "Copy branch name")],
    [
      i.mode === "local" && has("open-folder") && entry("open-folder", i.editor ? "Open in editor" : "Open folder"),
      has("pull-request") && !!i.pullRequest && entry("pull-request", i.pullRequest === "view" ? "View pull request" : "Open pull request"),
    ],
    [
      live && has("compact") && entry("compact", "Compact conversation"),
      live && has("move") && entry("move", i.mode === "local" ? "Move to the cloud" : "Move to this computer"),
    ],
    [
      has("archive") && entry("archive", i.archived ? "Unarchive" : "Archive"),
      i.mode === "local" && has("remove") && entry("remove", "Remove thread", { danger: true }),
    ],
  ];
  return groups.map(g => g.filter((e): e is ThreadMenuEntry => e !== false)).filter(g => g.length > 0);
}

// ── Fork into a new thread ─────────────────────────────────

const FORK_QUOTE_CHARS = 1200;

/**
 * The first message of a thread forked from another: what it was about and where it got
 * to, from the history cached on this computer (its first request and the agent's last
 * reply), so the new thread starts with the context and can go its own way.
 */
export function forkPrompt(t: { title: string; branch: string }, events: readonly ThreadEvent[]): string {
  const first = events.find(e => e.type === "user_message");
  const last = [...events].reverse().find(e => e.type === "agent_message" && !e.partial);
  const clip = (s: string) => {
    const one = s.trim();
    return one.length > FORK_QUOTE_CHARS ? `${one.slice(0, FORK_QUOTE_CHARS).trimEnd()}…` : one;
  };
  const lines = [`Carry on from the thread “${t.title}” (its work is on the branch ${t.branch}).`];
  if (first?.type === "user_message" && first.text.trim()) lines.push("", "It started with this request:", quote(clip(first.text)));
  if (last?.type === "agent_message" && last.text.trim()) lines.push("", "The agent's last reply was:", quote(clip(last.text)));
  lines.push("", "Here's what I'd like to do next: ");
  return lines.join("\n");
}

function quote(s: string): string {
  return s
    .split("\n")
    .map(l => `> ${l}`)
    .join("\n");
}

// ── Pull requests the app has seen ─────────────────────────

/**
 * Pull request links seen while a thread was open, so the sidebar's menu can offer them
 * too. Kept for this run of the app only.
 */
const pullRequests = new Map<string, string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, string> = new Map();

export function rememberPullRequest(threadId: string, url: string | null): void {
  if ((pullRequests.get(threadId) ?? null) === url) return;
  if (url) pullRequests.set(threadId, url);
  else pullRequests.delete(threadId);
  snapshot = new Map(pullRequests);
  for (const l of listeners) l();
}

export function subscribePullRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const knownPullRequests = (): ReadonlyMap<string, string> => snapshot;

// ── Opening a thread at one of its subagents ───────────────

export const REVEAL_CHILD_EVENT = "lemonlime:reveal-child";

let pendingReveal: { threadId: string; childId: string } | null = null;

/** Ask the thread's view to scroll to a subagent's row (now if it's open, or once it opens). */
export function requestRevealChild(threadId: string, childId: string): void {
  pendingReveal = { threadId, childId };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(REVEAL_CHILD_EVENT, { detail: pendingReveal }));
}

/** The subagent asked for in this thread, once (then it's forgotten). */
export function takeRevealChild(threadId: string): string | null {
  if (pendingReveal?.threadId !== threadId) return null;
  const id = pendingReveal.childId;
  pendingReveal = null;
  return id;
}

/** The timeline row a subagent started from: the agent's call that started it. */
export function childRowKey(events: readonly ThreadEvent[], childId: string): string | null {
  const call = events.find(e => e.type === "tool_call" && e.callId === childId);
  return call ? `e${call.seq}` : null;
}

/** What removing a local thread does, for the confirmation. */
export function removeThreadText(t: { title: string; branch: string }, machine: string | null): string {
  return machine
    ? `Remove “${t.title}” from LemonLime? The runner on ${machine} is stopped, and the thread's worktree and history there are removed. Your project there and the ${t.branch} branch are not touched.`
    : `Remove “${t.title}” from LemonLime? The runner is stopped and the history cached in this app is cleared. Your repository and the ${t.branch} branch are not touched.`;
}
