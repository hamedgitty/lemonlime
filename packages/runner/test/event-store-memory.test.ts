import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function historyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-store-"));
  dirs.push(dir);
  return join(dir, "events.jsonl");
}

function fill(store: EventStore, count: number, text = "hello"): void {
  for (let i = 0; i < count; i++) store.append({ type: "agent_message", text: `${text} ${store.latestSeq + 1}` });
}

/** How many events the store is holding in memory. */
const held = (store: EventStore) => (store as unknown as { recent: unknown[] }).recent.length;
const seqs = (store: EventStore, after: number) => store.since(after).map(e => e.seq);
const upTo = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

describe("event store with a very long history", () => {
  it("holds only the newest events in memory and reads older ones back from the file", () => {
    const store = new EventStore("long-thread-1", historyFile(), undefined, { events: 10 });
    fill(store, 100);
    expect(store.latestSeq).toBe(100);
    expect(held(store)).toBeLessThanOrEqual(13);
    expect(seqs(store, 0)).toEqual(upTo(1, 100));
    expect(seqs(store, 40)).toEqual(upTo(41, 100));
    expect(seqs(store, 97)).toEqual([98, 99, 100]);
    expect(seqs(store, 100)).toEqual([]);
    expect(store.since(0)[0]).toMatchObject({ type: "agent_message", text: "hello 1" });
  });

  it("counts large events by their size, not only by how many there are", () => {
    const store = new EventStore("long-thread-2", historyFile(), undefined, { chars: 4000 });
    fill(store, 60, "x".repeat(500));
    expect(held(store)).toBeLessThan(12);
    expect(seqs(store, 0)).toEqual(upTo(1, 60));
  });

  it("gives each new event the next number after a restart", () => {
    const file = historyFile();
    fill(new EventStore("long-thread-3", file, undefined, { events: 10 }), 100);
    const reopened = new EventStore("long-thread-3", file, undefined, { events: 10 });
    expect(reopened.latestSeq).toBe(100);
    expect(held(reopened)).toBeLessThanOrEqual(13);
    expect(reopened.append({ type: "agent_message", text: "after a restart" }).seq).toBe(101);
    expect(seqs(reopened, 0)).toEqual(upTo(1, 101));
  });

  it("keeps everything when there is no file to read it back from", () => {
    const store = new EventStore("long-thread-4", null, undefined, { events: 5 });
    fill(store, 50);
    expect(held(store)).toBe(50);
    expect(seqs(store, 0)).toEqual(upTo(1, 50));
  });

  it("never lets go of an event that isn't on disk yet", () => {
    const file = historyFile();
    const store = new EventStore("long-thread-5", file, undefined, { events: 5 });
    // A folder where the file should be makes every write fail, as a full disk would.
    mkdirSync(file);
    fill(store, 50);
    expect(seqs(store, 0)).toEqual(upTo(1, 50));
    rmSync(file, { recursive: true });
    fill(store, 20);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(70);
    expect(held(store)).toBeLessThan(70);
    expect(seqs(store, 0)).toEqual(upTo(1, 70));
  });

  it("starts on a new line after a half-written one, so the events after it aren't lost", () => {
    const file = historyFile();
    fill(new EventStore("long-thread-6", file), 2);
    // A crash in the middle of a write leaves half a line at the end.
    appendFileSync(file, '{"type":"agent_message","text":"cut sh');
    const afterCrash = new EventStore("long-thread-6", file, undefined, { events: 1 });
    expect(afterCrash.latestSeq).toBe(2);
    fill(afterCrash, 3);
    expect(seqs(afterCrash, 0)).toEqual(upTo(1, 5));
    expect(new EventStore("long-thread-6", file).latestSeq).toBe(5);
  });
});
