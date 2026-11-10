import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalThreadSnapshot, type ComputerUpdate } from "@lemonlime/protocol";
import { computerPlatform, helloForRunner, PhoneLink, threadSnapshots } from "../src/lib/phoneBridge.ts";
import type { LocalThreadMeta } from "../src/lib/storage.ts";

const meta = (id: string, over: Partial<LocalThreadMeta> = {}): LocalThreadMeta => ({
  id,
  title: "Fix the build",
  agent: { kind: "codex", model: "gpt-x", command: ["secret-wrapper", "--token", "abc"] },
  repoPath: "/Users/someone/code/my-app",
  baseBranch: "main",
  branch: `agent/${id}`,
  status: "idle",
  lastSeq: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...over,
});

describe("phone access on the desktop", () => {
  it("hands the runner a hello with this app's token and only where to resume", () => {
    const out = JSON.parse(helloForRunner(JSON.stringify({ type: "hello", resumeFrom: 12, computer: true, token: "phone-sent-this" }), "minted")!);
    expect(out).toEqual({ type: "hello", token: "minted", resumeFrom: 12 });
    expect(JSON.parse(helloForRunner('{"type":"hello","resumeFrom":-3}', "t")!).resumeFrom).toBe(0);
    expect(helloForRunner('{"type":"send_message","text":"x"}', "t")).toBeNull();
    expect(helloForRunner("not json", "t")).toBeNull();
  });

  it("shares threads without paths or commands, leaving archived ones out", () => {
    const list = threadSnapshots([meta("thread-aaaaaa"), meta("thread-bbbbbb")], {
      archived: { "thread-bbbbbb": "2026-01-03T00:00:00.000Z" },
      status: { "thread-aaaaaa": "running" },
    });
    expect(list).toHaveLength(1);
    expect(LocalThreadSnapshot.parse(list[0])).toEqual(list[0]);
    expect(list[0]).toMatchObject({ repoName: "my-app", status: "running", agent: { kind: "codex", model: "gpt-x" } });
    const text = JSON.stringify(list);
    expect(text).not.toContain("/Users/someone");
    expect(text).not.toContain("secret-wrapper");
  });

  it("tells computers apart", () => {
    expect(computerPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(computerPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(computerPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});

describe("the link to the dashboard", () => {
  class FakeSocket {
    static made: FakeSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      FakeSocket.made.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }

  beforeEach(() => {
    FakeSocket.made = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

  /** A link that is up, with a ticket due for renewal in ten seconds. */
  async function liveLink(nextTicket: () => Promise<{ url: string; ticket: string; expiresAt: string }>) {
    const saved: ComputerUpdate[] = [];
    let asked = 0;
    const link = new PhoneLink({
      api: {
        saveComputer: async (_id, body) => {
          saved.push(body);
          return { bridgeAvailable: true };
        },
        phoneLink: () => (asked++ === 0 ? Promise.resolve({ url: "wss://bridge.test/link", ticket: "first", expiresAt: inSeconds(130) }) : nextTicket()),
      },
      computer: { id: "c1", name: "Desk", platform: "mac" },
      threads: () => [],
      runner: async () => null,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.made[0]!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "linked" }) });
    return { link, socket, saved };
  }

  it("signs in with its ticket and renews it before it runs out", async () => {
    const { link, socket } = await liveLink(async () => ({ url: "wss://bridge.test/link", ticket: "second", expiresAt: inSeconds(600) }));
    expect(link.current).toBe("live");
    expect(socket.sent.map(s => JSON.parse(s))).toEqual([{ type: "auth", ticket: "first" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent.map(s => JSON.parse(s))).toContainEqual({ type: "renew", ticket: "second" });
    await link.stop({ tell: false });
  });

  it("starts nothing again when a new ticket arrives after phone access was turned off", async () => {
    let arrive!: (t: { url: string; ticket: string; expiresAt: string }) => void;
    const { link, socket, saved } = await liveLink(() => new Promise(r => (arrive = r)));
    await vi.advanceTimersByTimeAsync(10_000);
    await link.stop();
    expect(saved.at(-1)?.phoneAccess).toBe(false);
    const told = saved.length;
    arrive({ url: "wss://bridge.test/link", ticket: "second", expiresAt: inSeconds(600) });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // No check-in says phone access is on again, and the dead link gets no new ticket.
    expect(saved.length).toBe(told);
    expect(socket.sent.some(s => s.includes("renew"))).toBe(false);
    expect(link.current).toBe("off");
  });
});
