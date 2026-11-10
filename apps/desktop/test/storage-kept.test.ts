import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { forgetThread, loadDraft, loadEvents, loadHeld, loadSettings, parseStored, saveDraft, saveHeld, saveSettings, Settings } from "../src/lib/storage.ts";

/** A stand-in for local storage that refuses a write once `room` characters are used. */
function fakeStorage(room = Number.POSITIVE_INFINITY) {
  const store = new Map<string, string>();
  const used = () => [...store.values()].reduce((n, v) => n + v.length, 0);
  return {
    store,
    api: {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (used() - (store.get(k)?.length ?? 0) + v.length > room) throw new Error("QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

function useStorage(room?: number) {
  const fake = fakeStorage(room);
  (globalThis as { localStorage?: unknown }).localStorage = fake.api;
  return fake.store;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("reading what was stored", () => {
  const Shape = z.object({
    name: z.string().default("none"),
    size: z.number().default(3),
    tags: z.array(z.string()).default([]),
  });

  it("keeps the fields that still fit when one of them doesn't", () => {
    expect(parseStored(Shape, { name: "mine", size: "big", tags: ["a"] })).toEqual({ name: "mine", size: 3, tags: ["a"] });
  });

  it("falls back to the defaults for anything that isn't a record", () => {
    for (const stored of [undefined, null, "text", 7, ["a"]]) {
      expect(parseStored(Shape, stored)).toEqual({ name: "none", size: 3, tags: [] });
    }
  });

  it("leaves a good record alone and drops fields it doesn't know", () => {
    expect(parseStored(Shape, { name: "mine", size: 9, tags: [], extra: true })).toEqual({ name: "mine", size: 9, tags: [] });
  });

  it("keeps the rest of the settings when one was saved by another version", () => {
    const store = useStorage();
    store.set("lemonlime:settings", JSON.stringify({ runnerPath: "/opt/runner", stripCoauthors: "yes" }));
    const settings = loadSettings();
    expect(settings.runnerPath).toBe("/opt/runner");
    expect(settings.stripCoauthors).toBe(Settings.parse({}).stripCoauthors);
  });
});

describe("messages held for a thread", () => {
  beforeEach(() => void useStorage());

  it("are kept per thread and read back", () => {
    saveHeld("t1", [{ id: "a", text: "After the subagents" }]);
    expect(loadHeld("t1")).toEqual([{ id: "a", text: "After the subagents" }]);
    expect(loadHeld("t2")).toEqual([]);
  });

  it("leave nothing behind once they have gone", () => {
    const store = (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage;
    saveHeld("t1", [{ id: "a", text: "Later" }]);
    saveHeld("t1", []);
    expect(store.getItem("lemonlime:held:t1")).toBeNull();
    expect(loadHeld("t1")).toEqual([]);
  });

  it("read as none when what was stored is damaged", () => {
    const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage;
    store.setItem("lemonlime:held:t1", "{not json");
    expect(loadHeld("t1")).toEqual([]);
    store.setItem("lemonlime:held:t1", JSON.stringify([{ id: 1 }]));
    expect(loadHeld("t1")).toEqual([]);
  });
});

describe("a thread that is gone for good", () => {
  it("takes its cached timeline, its draft and its held messages with it", () => {
    const store = useStorage();
    store.set("lemonlime:events:t1", "[]");
    saveDraft("t1", "half a thought");
    saveHeld("t1", [{ id: "a", text: "Later" }]);
    saveDraft("t2", "another thread's");
    forgetThread("t1");
    expect([...store.keys()].filter(k => k.endsWith(":t1"))).toEqual([]);
    expect(loadDraft("t2")).toBe("another thread's");
  });
});

describe("saving when storage is full", () => {
  const event = (seq: number, text: string) => ({
    seq,
    type: "user_message",
    threadId: "t",
    at: "2026-01-01T00:00:00.000Z",
    text,
  });

  it("drops the biggest cached timelines, one at a time, until the settings fit", () => {
    const small = JSON.stringify([event(1, "hi")]);
    const big = JSON.stringify([event(1, "x".repeat(4000))]);
    const settings = JSON.stringify({ ...Settings.parse({}), accessToken: "" }).length;
    // Room for the small timeline and the settings, not for the big one too.
    const store = useStorage(small.length + settings + 200);
    store.set("lemonlime:events:big", big);
    store.set("lemonlime:events:small", small);
    saveSettings({ ...Settings.parse({}), runnerPath: "/opt/runner" });
    expect(loadSettings().runnerPath).toBe("/opt/runner");
    expect(store.has("lemonlime:events:big")).toBe(false);
    expect(store.has("lemonlime:events:small")).toBe(true);
  });

  it("never stores the access token with the settings", () => {
    const store = useStorage();
    saveSettings({ ...Settings.parse({}), accessToken: "not-kept-here" });
    expect(store.get("lemonlime:settings")).not.toContain("not-kept-here");
  });

  it("gives up quietly when nothing it may drop makes room", () => {
    const store = useStorage(10);
    expect(() => saveSettings(Settings.parse({}))).not.toThrow();
    expect(store.has("lemonlime:settings")).toBe(false);
    expect(loadEvents("t")).toEqual([]);
  });
});
