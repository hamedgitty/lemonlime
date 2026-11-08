import { z } from "zod";

/**
 * The notification centre: recent things that happened across threads (finished, waiting
 * for you, failed, an automation ran or was skipped), kept in local storage on this
 * computer. Newest first, capped, each one read or not.
 */

export const INBOX_LIMIT = 60;
const KEY = "lemonlime:inbox";

export const InboxKind = z.enum(["finished", "waiting", "failed", "automation-ran", "automation-skipped", "automation-failed"]);
export type InboxKind = z.infer<typeof InboxKind>;

export const InboxItem = z.object({
  /** Stable for one happening, so the same thing is never listed twice. */
  id: z.string(),
  kind: InboxKind,
  title: z.string(),
  detail: z.string().default(""),
  at: z.string(),
  read: z.boolean().default(false),
  /** The thread to open, if any. */
  thread: z.object({ mode: z.enum(["local", "cloud"]), id: z.string() }).optional(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const Inbox = z.object({
  items: z.array(InboxItem).default([]),
  /** When this computer started keeping the list (ISO): older automation runs aren't news. */
  since: z.string().default(""),
});
export type Inbox = z.infer<typeof Inbox>;

/** Add one (newest first); one already listed is left as it is. */
export function addToInbox(inbox: Inbox, item: Omit<InboxItem, "read" | "detail"> & { detail?: string; read?: boolean }): Inbox {
  if (inbox.items.some(i => i.id === item.id)) return inbox;
  const next = InboxItem.parse(item);
  const items = [next, ...inbox.items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, INBOX_LIMIT);
  return { ...inbox, items };
}

export function unreadCount(inbox: Inbox): number {
  return inbox.items.filter(i => !i.read).length;
}

export function markAllRead(inbox: Inbox): Inbox {
  return inbox.items.some(i => !i.read) ? { ...inbox, items: inbox.items.map(i => (i.read ? i : { ...i, read: true })) } : inbox;
}

export function markRead(inbox: Inbox, id: string): Inbox {
  return inbox.items.some(i => i.id === id && !i.read) ? { ...inbox, items: inbox.items.map(i => (i.id === id ? { ...i, read: true } : i)) } : inbox;
}

/** Opening a thread counts as reading what it said. */
export function markThreadRead(inbox: Inbox, threadId: string): Inbox {
  return inbox.items.some(i => i.thread?.id === threadId && !i.read)
    ? { ...inbox, items: inbox.items.map(i => (i.thread?.id === threadId && !i.read ? { ...i, read: true } : i)) }
    : inbox;
}

export function loadInbox(now = new Date()): Inbox {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = Inbox.safeParse(raw ? JSON.parse(raw) : {});
    const inbox = parsed.success ? parsed.data : Inbox.parse({});
    return inbox.since ? inbox : { ...inbox, since: now.toISOString() };
  } catch {
    return { items: [], since: now.toISOString() };
  }
}

export function saveInbox(inbox: Inbox): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(inbox));
  } catch {
    /* storage full: the list is a convenience */
  }
}

/** Inbox entries for automation runs that happened since the list began, by outcome. */
export function automationRunItems(
  automations: readonly {
    id: string;
    name: string;
    recentRuns?: readonly {
      id: string;
      status: string;
      outcome?: string;
      ranAt: string;
      threadId: string | null;
      detail: string | null;
      summary?: string | null;
    }[];
  }[],
  since: string,
): Omit<InboxItem, "read">[] {
  const out: Omit<InboxItem, "read">[] = [];
  for (const a of automations) {
    for (const r of a.recentRuns ?? []) {
      if (!since || r.ranAt <= since) continue;
      const outcome = r.outcome ?? r.status;
      const kind: InboxKind | null =
        outcome === "skipped" ? "automation-skipped" : outcome === "failed" ? "automation-failed" : outcome === "finished" ? "automation-ran" : null;
      if (!kind) continue; // still going: it'll be news when it's done
      out.push({
        id: `run:${r.id}:${kind}`,
        kind,
        title: a.name,
        detail:
          kind === "automation-ran"
            ? (r.summary ?? "The automation ran.")
            : kind === "automation-skipped"
              ? (r.detail ?? "The automation was skipped.")
              : (r.detail ?? r.summary ?? "The automation failed."),
        at: r.ranAt,
        ...(r.threadId && kind !== "automation-skipped" ? { thread: { mode: "cloud" as const, id: r.threadId } } : {}),
      });
    }
  }
  return out;
}
