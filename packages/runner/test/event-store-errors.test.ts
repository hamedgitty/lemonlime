import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/index.ts";

describe("event store when the disk fails", () => {
  it("keeps going, keeps events in order, and saves them once it can write again", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-store-"));
    const file = join(dir, "events.jsonl");
    const store = new EventStore("store-thread-1", file);
    // A folder where the file should be makes every write fail, as a full disk would.
    mkdirSync(file);
    const a = store.append({ type: "agent_message", text: "one" });
    const b = store.append({ type: "agent_message", text: "two" });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(store.since(0)).toHaveLength(2);

    rmSync(file, { recursive: true });
    store.append({ type: "agent_message", text: "three" });
    const saved = readFileSync(file, "utf8").trim().split("\n").map(l => (JSON.parse(l) as { seq: number }).seq);
    expect(saved).toEqual([1, 2, 3]);
    // Only this user can read it.
    expect(statSync(file).mode & 0o077).toBe(0);
    // And it loads back whole.
    expect(new EventStore("store-thread-1", file).latestSeq).toBe(3);
  });
});
