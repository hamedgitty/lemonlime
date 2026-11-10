import { describe, expect, it } from "vitest";
import { branchForThread, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import { RunnerClient, type ConnectionState } from "../src/index.ts";

const THREAD = "client-test-1";

/** A stand-in WebSocket the test drives by hand. Nothing touches the network. */
function fakeSockets() {
  const made: FakeSocket[] = [];
  class FakeSocket {
    readyState = 0;
    readonly sent: Array<Record<string, unknown>> = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      made.push(this);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close(code = 1000): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code }));
    }
    /** The runner accepts the connection. */
    accept(): void {
      this.readyState = 1;
      this.onopen?.();
    }
    /** The runner says something. */
    say(msg: unknown): void {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }
  return { made, WebSocketImpl: FakeSocket as unknown as typeof WebSocket };
}

function welcome(latestSeq: number) {
  const now = new Date().toISOString();
  const thread: Thread = {
    id: THREAD,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(THREAD),
    mode: "local",
    status: "idle",
    sandboxSize: "small",
    latestSeq,
    createdAt: now,
    updatedAt: now,
  };
  return { type: "welcome", thread, latestSeq, runnerVersion: "t" };
}

const event = (seq: number, text: string) => ({ type: "event", event: { type: "agent_message", threadId: THREAD, seq, at: new Date().toISOString(), text } });

/** Let promises and zero-delay timers that are already due run. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** A token that arrives when the test says so. */
function slowToken() {
  const waiting: Array<(token: string) => void> = [];
  return { waiting, token: () => new Promise<string>(resolve => waiting.push(resolve)) };
}

describe("RunnerClient connecting", () => {
  it("opens no connection when it was closed while its token was on the way", async () => {
    const { made, WebSocketImpl } = fakeSockets();
    const { waiting, token } = slowToken();
    const states: ConnectionState[] = [];
    const client = new RunnerClient({ url: "ws://runner/ws", token, WebSocketImpl, onState: s => states.push(s) });
    client.connect();
    client.close();
    waiting[0]!("t1");
    await tick();
    expect(made).toHaveLength(0);
    expect(states.at(-1)).toBe("closed");
  });

  it("opens one connection when asked to reconnect while its token is on the way", async () => {
    const { made, WebSocketImpl } = fakeSockets();
    const { waiting, token } = slowToken();
    const client = new RunnerClient({ url: "ws://runner/ws", token, WebSocketImpl });
    client.connect();
    client.reconnectNow();
    client.reconnectNow();
    expect(waiting).toHaveLength(1);
    waiting[0]!("t1");
    await tick();
    expect(made).toHaveLength(1);
    made[0]!.accept();
    expect(made[0]!.sent).toEqual([{ type: "hello", token: "t1", resumeFrom: 0 }]);
    client.close();
  });

  it("connects again when closed and reopened while a token is on the way", async () => {
    const { made, WebSocketImpl } = fakeSockets();
    const { waiting, token } = slowToken();
    const client = new RunnerClient({ url: "ws://runner/ws", token, WebSocketImpl });
    client.connect();
    client.close();
    client.connect();
    for (const give of waiting) give("t1");
    await tick();
    expect(made).toHaveLength(1);
    client.close();
  });
});

describe("RunnerClient and a runner whose history started over", () => {
  it("asks for the whole history again and passes on its events", async () => {
    const { made, WebSocketImpl } = fakeSockets();
    const got: ThreadEvent[] = [];
    let resets = 0;
    const client = new RunnerClient({ url: "ws://runner/ws", token: "t", resumeFrom: 40, WebSocketImpl, onEvent: e => got.push(e), onReset: () => resets++ });
    client.connect();
    await tick();
    made[0]!.accept();
    expect(made[0]!.sent[0]).toMatchObject({ type: "hello", resumeFrom: 40 });

    // The runner only has two events: fewer than the forty this client has seen.
    made[0]!.say(welcome(2));
    expect(resets).toBe(1);
    // Anything more on the old connection is left for the new one.
    made[0]!.say(event(3, "three"));
    made[0]!.say({ type: "caught_up", latestSeq: 3 });
    expect(got).toEqual([]);
    await tick();

    expect(made).toHaveLength(2);
    expect(made[0]!.readyState).toBe(3);
    made[1]!.accept();
    expect(made[1]!.sent[0]).toMatchObject({ type: "hello", resumeFrom: 0 });
    made[1]!.say(welcome(3));
    for (const [seq, text] of [
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ] as const)
      made[1]!.say(event(seq, text));
    made[1]!.say({ type: "caught_up", latestSeq: 3 });
    expect(got.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(resets).toBe(1);
    expect(client.seq).toBe(3);
    expect(made).toHaveLength(2);
    client.close();
  });

  it("carries on as usual when the runner has as much history as the client, or more", async () => {
    const { made, WebSocketImpl } = fakeSockets();
    const got: ThreadEvent[] = [];
    let resets = 0;
    const client = new RunnerClient({ url: "ws://runner/ws", token: "t", resumeFrom: 2, WebSocketImpl, onEvent: e => got.push(e), onReset: () => resets++ });
    client.connect();
    await tick();
    made[0]!.accept();
    made[0]!.say(welcome(3));
    made[0]!.say(event(2, "two"));
    made[0]!.say(event(3, "three"));
    made[0]!.say({ type: "caught_up", latestSeq: 3 });
    await tick();
    expect(got.map(e => e.seq)).toEqual([3]);
    expect(resets).toBe(0);
    expect(made).toHaveLength(1);
    client.close();
  });
});
