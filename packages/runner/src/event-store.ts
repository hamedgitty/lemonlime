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

  constructor(
    readonly threadId: string,
    private readonly file: string | null,
  ) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
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

  /** Assign seq + timestamp, persist, then notify subscribers. */
  append(event: NewEvent): ThreadEvent {
    const full = ThreadEvent.parse({
      ...capEvent(event),
      threadId: this.threadId,
      seq: this.events.length + 1,
      at: new Date().toISOString(),
    });
    if (this.file) appendFileSync(this.file, JSON.stringify(full) + "\n");
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
