import { describe, expect, it } from "vitest";
import {
  branchForThread,
  ClientMessage,
  deriveThreadSecret,
  newThreadId,
  parseClientMessage,
  signToken,
  ThreadEvent,
  ThreadId,
  verifyToken,
} from "../src/index.ts";

const SECRET = "a-test-secret-that-is-long-enough";

describe("thread ids and branches", () => {
  it("generates valid, sortable ids", () => {
    const a = newThreadId(1_700_000_000_000);
    const b = newThreadId(1_800_000_000_000);
    expect(ThreadId.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
  });

  it("puts every thread on agent/<id>", () => {
    expect(branchForThread("abc123")).toBe("agent/abc123");
  });
});

describe("events", () => {
  it("accepts every event type and fills defaults", () => {
    const base = { threadId: "abc123", seq: 1, at: new Date().toISOString() };
    const msg = ThreadEvent.parse({ ...base, type: "agent_message", text: "hi" });
    expect(msg.type === "agent_message" && msg.partial).toBe(false);
    for (const e of [
      { type: "user_message", text: "x" },
      { type: "tool_call", callId: "1", name: "shell", input: { command: "ls" } },
      { type: "tool_result", callId: "1", output: "ok" },
      { type: "file_diff", path: "a.ts", change: "modified", diff: "@@" },
      { type: "status_change", from: "idle", to: "running" },
      { type: "error", message: "boom" },
    ]) {
      expect(ThreadEvent.safeParse({ ...base, ...e }).success).toBe(true);
    }
  });

  it("rejects a non-positive seq", () => {
    expect(ThreadEvent.safeParse({ threadId: "abc123", seq: 0, at: new Date().toISOString(), type: "user_message", text: "x" }).success).toBe(false);
  });
});

describe("wire messages", () => {
  it("parses hello with a default resume point", () => {
    const m = parseClientMessage(JSON.stringify({ type: "hello", token: "t" }));
    expect(m).toEqual({ type: "hello", token: "t", resumeFrom: 0 });
  });

  it("returns null for garbage instead of throwing", () => {
    expect(parseClientMessage("{nope")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "explode" }))).toBeNull();
    expect(ClientMessage.safeParse({ type: "send_message", text: "" }).success).toBe(false);
  });
});

describe("tokens", () => {
  it("round-trips claims", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await signToken({ threadId: "abc123", scope: "client", exp, sub: "user-1" }, SECRET);
    const res = await verifyToken(token, SECRET);
    expect(res).toEqual({ ok: true, claims: { threadId: "abc123", scope: "client", exp, sub: "user-1" } });
  });

  it("rejects a wrong secret, tampering and expiry", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await signToken({ threadId: "abc123", scope: "client", exp }, SECRET);
    expect(await verifyToken(token, "another-secret-that-is-long")).toEqual({ ok: false, reason: "bad_signature" });

    const [payload, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ threadId: "zzz999", scope: "client", exp })).replace(/=+$/, "");
    expect((await verifyToken(`${forged}.${sig}`, SECRET)).ok).toBe(false);
    expect(await verifyToken(`${payload}`, SECRET)).toEqual({ ok: false, reason: "malformed" });

    const old = await signToken({ threadId: "abc123", scope: "client", exp: 10 }, SECRET);
    expect(await verifyToken(old, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("derives a different secret per thread", async () => {
    const a = await deriveThreadSecret(SECRET, "thread-aaa");
    const b = await deriveThreadSecret(SECRET, "thread-bbb");
    expect(a).not.toBe(b);
    expect(a).toBe(await deriveThreadSecret(SECRET, "thread-aaa"));
    // A token signed with one thread's secret is useless for another thread's runner.
    const token = await signToken({ threadId: "thread-aaa", scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, a);
    expect((await verifyToken(token, b)).ok).toBe(false);
  });
});
