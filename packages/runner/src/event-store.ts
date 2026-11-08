import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { capEvent } from "./limits.ts";

type Listener = (event: ThreadEvent) => void;

/**
 * Append-only event history for one thread, stored as JSON Lines.
 * Every event gets the next `seq` (starting at 1). History is never rewritten,
 * so any client can resume from any seq.
 */
export class EventStore {
  private readonly events: ThreadEvent[] = [];
  private readonly listeners = new Set<Listener>();
  /** Lines not yet on disk because a write failed (a full disk); retried on the next append. */
  private unsaved: string[] = [];
  private warned = false;

  constructor(
    readonly threadId: string,
    private readonly file: string | null,
    /** Applied to every new event before it is stored, e.g. to remove secrets. */
    private readonly transform: (event: NewEvent) => NewEvent = e => e,
  ) {
    if (file) {
      // Only this user may read a thread's history.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (existsSync(file)) this.load(file);
    }
  }

  private load(file: string): void {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = ThreadEvent.safeParse(safeJson(line));
      // A torn final line (crash mid-write) is skipped; earlier lines are intact.
      if (parsed.success && parsed.data.seq === this.events.length + 1) this.events.push(parsed.data);
    }
  }

  get latestSeq(): number {
    return this.events.length;
  }

  /**
   * Assign seq + timestamp, persist, then notify subscribers. `at` keeps an event's
   * original time (history imported from elsewhere); live events are stamped now.
   */
  append(event: NewEvent, at: string = new Date().toISOString()): ThreadEvent {
    const full = ThreadEvent.parse({
      ...capEvent(this.transform(event)),
      threadId: this.threadId,
      seq: this.events.length + 1,
      at,
    });
    if (this.file) this.persist(JSON.stringify(full) + "\n");
    this.events.push(full);
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* a broken listener must not break the store */
      }
    }
    return full;
  }

  /**
   * Write a line, along with any earlier ones that couldn't be written. A failed write (the
   * disk is full) must not stop the thread: the event stays in memory and in order, and is
   * written once there's room again.
   */
  private persist(line: string): void {
    this.unsaved.push(line);
    try {
      appendFileSync(this.file!, this.unsaved.join(""), { mode: 0o600 });
      this.unsaved = [];
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`lemonlime-runner: couldn't save thread history (${(err as Error).message}); keeping it in memory and retrying\n`);
      }
    }
  }

  /** Events with seq > after, in order. */
  since(after: number): ThreadEvent[] {
    return this.events.slice(Math.max(0, after));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
