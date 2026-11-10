import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { capEvent } from "./limits.ts";

type Listener = (event: ThreadEvent) => void;

/** How much of a saved history stays in memory: the newest events, up to this many and this much text. */
export interface KeepInMemory {
  events: number;
  chars: number;
}

const KEEP_IN_MEMORY: KeepInMemory = { events: 10_000, chars: 32 * 1024 * 1024 };

/**
 * Append-only event history for one thread, stored as JSON Lines.
 * Every event gets the next `seq` (starting at 1). History is never rewritten,
 * so any client can resume from any seq.
 *
 * Only the newest events are held in memory, so a very long thread can't use it all up.
 * Older ones stay in the file and are read back when someone asks for them. A history with
 * no file keeps everything, because there is nowhere else to read it from.
 */
export class EventStore {
  /** The newest events, in order. The first one's seq is `count - recent.length + 1`. */
  private recent: ThreadEvent[] = [];
  /** How long each of those is as saved text, to know how much is held. */
  private sizes: number[] = [];
  private held = 0;
  private count = 0;
  private readonly listeners = new Set<Listener>();
  /** Lines not yet on disk because a write failed (a full disk); retried on the next append. */
  private unsaved: string[] = [];
  private warned = false;
  /** The file ends in half a line (a crash mid-write), so the next line must start on a new one. */
  private torn = false;
  private readonly keep: KeepInMemory;

  constructor(
    readonly threadId: string,
    private readonly file: string | null,
    /** Applied to every new event before it is stored, e.g. to remove secrets. */
    private readonly transform: (event: NewEvent) => NewEvent = e => e,
    keep: Partial<KeepInMemory> = {},
  ) {
    this.keep = { ...KEEP_IN_MEMORY, ...keep };
    if (file) {
      // Only this user may read a thread's history.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (existsSync(file)) {
        this.torn = scan(file, (event, size) => {
          this.count = event.seq;
          this.remember(event, size);
          return true;
        });
      }
    }
  }

  get latestSeq(): number {
    return this.count;
  }

  /**
   * Assign seq + timestamp, persist, then notify subscribers. `at` keeps an event's
   * original time (history imported from elsewhere); live events are stamped now.
   */
  append(event: NewEvent, at: string = new Date().toISOString()): ThreadEvent {
    const full = ThreadEvent.parse({
      ...capEvent(this.transform(event)),
      threadId: this.threadId,
      seq: this.count + 1,
      at,
    });
    const line = JSON.stringify(full) + "\n";
    if (this.file) this.persist(line);
    this.count = full.seq;
    this.remember(full, line.length);
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
      appendFileSync(this.file!, (this.torn ? "\n" : "") + this.unsaved.join(""), { mode: 0o600 });
      this.unsaved = [];
      this.torn = false;
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`lemonlime-runner: couldn't save thread history (${(err as Error).message}); keeping it in memory and retrying\n`);
      }
    }
  }

  /** Hold an event in memory, and let go of the oldest ones once there are too many. */
  private remember(event: ThreadEvent, size: number): void {
    this.recent.push(event);
    this.sizes.push(size);
    this.held += size;
    // Nothing leaves memory unless it can be read back: there must be a file, and nothing
    // waiting to be written to it. Letting go in batches keeps this cheap.
    if (!this.file || this.unsaved.length > 0) return;
    if (this.recent.length <= this.keep.events * 1.25 && this.held <= this.keep.chars * 1.25) return;
    let drop = 0;
    let held = this.held;
    while (drop < this.recent.length - 1 && (this.recent.length - drop > this.keep.events || held > this.keep.chars)) {
      held -= this.sizes[drop]!;
      drop++;
    }
    this.recent = this.recent.slice(drop);
    this.sizes = this.sizes.slice(drop);
    this.held = held;
  }

  /** Events with seq > after, in order. */
  since(after: number): ThreadEvent[] {
    const from = Math.max(0, Math.floor(after));
    const firstHeld = this.count - this.recent.length + 1;
    if (from >= firstHeld - 1 || !this.file) return this.recent.slice(Math.max(0, from - (firstHeld - 1)));
    // Some of what was asked for is only in the file.
    const older: ThreadEvent[] = [];
    try {
      scan(this.file, event => {
        if (event.seq >= firstHeld) return false;
        if (event.seq > from) older.push(event);
        return true;
      });
    } catch (err) {
      process.stderr.write(`lemonlime-runner: couldn't read older thread history (${(err as Error).message})\n`);
    }
    return [...older, ...this.recent];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Read a history file a piece at a time, handing over each event in order until `visit`
 * returns false. Lines that aren't the next event are skipped: a torn final line from a
 * crash mid-write, or anything that isn't an event. Returns whether the file ends without
 * a line break.
 */
function scan(file: string, visit: (event: ThreadEvent, size: number) => boolean): boolean {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const decoder = new StringDecoder("utf8");
    let expected = 1;
    let rest = "";
    const take = (line: string): boolean => {
      if (!line.trim()) return true;
      const parsed = ThreadEvent.safeParse(safeJson(line));
      if (!parsed.success || parsed.data.seq !== expected) return true;
      expected++;
      return visit(parsed.data, line.length + 1);
    };
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const lines = (rest + decoder.write(buffer.subarray(0, read))).split("\n");
      rest = lines.pop()!;
      for (const line of lines) if (!take(line)) return false;
    }
    rest += decoder.end();
    if (rest) take(rest);
    return rest !== "";
  } finally {
    closeSync(fd);
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
