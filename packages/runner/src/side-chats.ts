import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewEvent, ThreadEvent } from "@lemonlime/protocol";
import type { AgentAdapter, AgentSession, SessionOptions } from "./agents/index.ts";

export interface SideChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  busy: boolean;
}

interface SideChat {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  events: ThreadEvent[];
  session: AgentSession | null;
  busy: boolean;
  /** Context for the first turn, from the thread as it was when the chat started. */
  recap: string | null;
}

export type SideListener = (sideId: string, event: ThreadEvent) => void;

const FRAMING =
  "This is a side conversation next to the main thread: the user wants to ask about it without interrupting it. Answer their questions. Read files if that helps, but don't change anything; the main thread's agent does the work.";

/**
 * Side chats: quick questions about a thread, answered by a separate, read-only agent
 * conversation that starts from a recap of the thread. They never touch the thread's
 * history or files. Unpinned chats are discarded when closed (or when the runner stops);
 * pinned ones are kept in the thread's data folder.
 */
export class SideChats {
  private chats = new Map<string, SideChat>();
  private listeners = new Set<SideListener>();
  private listListeners = new Set<(chats: SideChatSummary[]) => void>();

  constructor(
    private readonly opts: {
      threadId: string;
      adapter: AgentAdapter;
      session: Omit<SessionOptions, "cwd" | "saved" | "autonomy">;
      cwd: string;
      /** Where pinned chats are kept; null keeps them in memory only. */
      dir: string | null;
      /** A recap of the main thread so far. */
      recap: () => string | null;
      /** Hides secrets, as in the thread's own history. */
      redact?: (e: NewEvent) => NewEvent;
    },
  ) {
    if (opts.dir && existsSync(opts.dir)) {
      for (const f of readdirSync(opts.dir).filter(f => f.endsWith(".json"))) {
        try {
          const saved = JSON.parse(readFileSync(join(opts.dir, f), "utf8")) as Pick<SideChat, "id" | "title" | "createdAt" | "events">;
          this.chats.set(saved.id, { ...saved, pinned: true, session: null, busy: false, recap: null });
        } catch {
          /* a damaged file is skipped */
        }
      }
    }
  }

  list(): SideChatSummary[] {
    return [...this.chats.values()]
      .map(c => ({ id: c.id, title: c.title, pinned: c.pinned, createdAt: c.createdAt, busy: c.busy }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  history(id: string): ThreadEvent[] {
    return this.chats.get(id)?.events ?? [];
  }

  subscribe(l: SideListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onList(l: (chats: SideChatSummary[]) => void): () => void {
    this.listListeners.add(l);
    return () => this.listListeners.delete(l);
  }

  /** Ask in a side chat; starts a new one without `id`. Returns the chat's id. */
  ask(text: string, id?: string): string | { error: string } {
    let chat = id ? this.chats.get(id) : undefined;
    if (id && !chat) return { error: "That side chat is gone." };
    if (chat?.busy) return { error: "Still answering the last question." };
    if (!chat) {
      chat = {
        id: randomUUID(),
        title: text.slice(0, 80),
        pinned: false,
        createdAt: new Date().toISOString(),
        events: [],
        session: null,
        busy: false,
        recap: this.opts.recap(),
      };
      this.chats.set(chat.id, chat);
    }
    void this.run(chat, text);
    this.publishList();
    return chat.id;
  }

  pin(id: string, pinned: boolean): boolean {
    const chat = this.chats.get(id);
    if (!chat) return false;
    chat.pinned = pinned;
    this.persist(chat);
    this.publishList();
    return true;
  }

  /** Close a chat: unpinned ones are gone for good, pinned ones just stop their agent. */
  async close(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (!chat) return;
    await chat.session?.dispose();
    chat.session = null;
    if (!chat.pinned) {
      this.chats.delete(id);
      this.publishList();
    }
  }

  async closeAll(): Promise<void> {
    for (const c of this.chats.values()) await c.session?.dispose();
  }

  private append(chat: SideChat, e: NewEvent): void {
    const clean = this.opts.redact ? this.opts.redact(e) : e;
    const event = { ...clean, threadId: this.opts.threadId, seq: chat.events.length + 1, at: new Date().toISOString() } as ThreadEvent;
    chat.events.push(event);
    for (const l of this.listeners) l(chat.id, event);
  }

  private async run(chat: SideChat, text: string): Promise<void> {
    chat.busy = true;
    this.append(chat, { type: "user_message", text });
    const first = !chat.session && chat.events.filter(e => e.type === "user_message").length === 1;
    chat.session ??= this.opts.adapter.createSession({ ...this.opts.session, autonomy: "read", subagents: false, cwd: this.opts.cwd, saved: {} });
    // A pinned chat reopened later has no agent conversation: give it the chat so far.
    const earlier = !first && chat.events.length > 1 ? sideRecap(chat.events.slice(0, -1)) : null;
    const prompt = [FRAMING, first ? chat.recap : earlier, text].filter(Boolean).join("\n\n");
    try {
      await chat.session.runTurn({ prompt, signal: new AbortController().signal, emit: e => this.append(chat, e) });
    } catch (err) {
      this.append(chat, { type: "error", message: err instanceof Error ? err.message : String(err), fatal: false });
    } finally {
      chat.busy = false;
      chat.recap = null;
      if (chat.pinned) this.persist(chat);
      this.publishList();
    }
  }

  private persist(chat: SideChat): void {
    if (!this.opts.dir) return;
    const file = join(this.opts.dir, `${chat.id}.json`);
    if (!chat.pinned) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(this.opts.dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ id: chat.id, title: chat.title, createdAt: chat.createdAt, events: chat.events }));
  }

  private publishList(): void {
    const list = this.list();
    for (const l of this.listListeners) l(list);
  }
}

function sideRecap(events: ThreadEvent[]): string | null {
  const lines = events.flatMap(e => (e.type === "user_message" ? [`User: ${e.text}`] : e.type === "agent_message" && !e.partial ? [`You: ${e.text}`] : []));
  return lines.length ? `This side chat so far:\n\n${lines.join("\n\n").slice(-16_000)}` : null;
}
