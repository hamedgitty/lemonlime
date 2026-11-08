import { describe, expect, it } from "vitest";
import { ThreadEvent, type AccountsList, type EventOf, type NewEvent } from "@lemonlime/protocol";
import { buildTimeline } from "../src/lib/timeline.ts";
import { limitChoices, threadsOnSameLimit } from "../src/lib/accounts.ts";
import type { AgentInstall, LocalRunnerStatus } from "../src/lib/system.ts";

const threadId = "limit-thread-1";
const at = "2026-11-08T12:00:00.000Z";
let seq = 0;
const ev = (e: NewEvent): ThreadEvent => ThreadEvent.parse({ threadId, at, ...e, seq: ++seq });

const hitEvent = (extra: Partial<EventOf<"limit_hit">> = {}): NewEvent => ({
  type: "limit_hit",
  agent: "claude-code",
  account: { id: "work", label: "Work" },
  resetAt: "2026-11-08T15:00:00.000Z",
  message: "You've hit your limit · resets 3pm",
  accounts: [{ id: "personal", label: "Personal" }],
  agents: ["codex"],
  ...extra,
});

describe("the limit row", () => {
  it("stays open until a turn starts, and takes in the waiting notices", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", text: "Add dark mode", clientMsgId: "m1" }),
      ev({ type: "status_change", from: "idle", to: "running" }),
      ev({ type: "status_change", from: "running", to: "idle" }),
      ev(hitEvent()),
      ev({ type: "notice", code: "usage_limited", message: "Your plan's usage limit…", untilAt: "2026-11-08T15:00:00.000Z" }),
    ];
    let items = buildTimeline(events);
    const limit = items.find(i => i.kind === "limit");
    expect(limit).toMatchObject({ open: true, waiting: { until: "2026-11-08T15:00:00.000Z" } });
    // The waiting notice is shown in the row, not on its own.
    expect(items.some(i => i.kind === "notice" && i.code === "usage_limited")).toBe(false);

    items = buildTimeline([
      ...events,
      ev({
        type: "agent_switch",
        from: { agent: "claude-code", account: { id: "work", label: "Work" } },
        to: { agent: "claude-code", account: { id: "personal", label: "Personal" } },
        carried: "session",
      }),
      ev({ type: "status_change", from: "idle", to: "running" }),
    ]);
    expect(items.find(i => i.kind === "limit")).toMatchObject({ open: false, waiting: null });
    expect(items.find(i => i.kind === "switch")).toMatchObject({ event: { carried: "session", auto: false } });
  });

  it("shows when LemonLime stops waiting, and closes an older limit when a new one comes", () => {
    seq = 0;
    const items = buildTimeline([
      ev(hitEvent()),
      ev({ type: "notice", code: "retry_scheduled", message: "…", untilAt: "2026-11-08T15:01:00.000Z" }),
      ev({ type: "notice", code: "retry_cancelled", message: "You sent a new message, so LemonLime stopped waiting." }),
      ev(hitEvent({ agent: "codex", account: undefined })),
    ]);
    const limits = items.filter(i => i.kind === "limit");
    expect(limits.map(l => [l.open, l.waiting])).toEqual([
      [false, null],
      [true, null],
    ]);
    expect(items.some(i => i.kind === "notice" && i.code === "retry_cancelled")).toBe(true);
  });
});

describe("what a limit row offers", () => {
  seq = 0;
  const hit = ev(hitEvent()) as EventOf<"limit_hit">;
  const accounts: AccountsList = {
    onLimit: "ask",
    agents: {
      "claude-code": [
        { id: "default", label: "This computer's sign-in", builtIn: true, isDefault: false, signedIn: true, email: "me@example.com" },
        { id: "work", label: "Work", builtIn: false, isDefault: true, signedIn: true },
        { id: "spare", label: "Spare", builtIn: false, isDefault: false, signedIn: false },
      ],
      codex: [],
    },
  };
  const agents: AgentInstall[] = [
    { kind: "claude-code", installed: true, path: "/x", version: "2", signedIn: true },
    { kind: "codex", installed: true, path: "/x", version: "1", signedIn: null },
    { kind: "opencode", installed: false, path: null, version: null, signedIn: null },
  ];

  it("on this computer: signed-in accounts now, and agents signed in here with a matching model", () => {
    const c = limitChoices({ hit, mode: "local", model: "opus", accounts, agents });
    expect(c.accounts).toEqual([{ id: "default", label: "This computer's sign-in", email: "me@example.com" }]);
    expect(c.agents).toEqual([{ kind: "codex", model: "gpt-6.1-sol" }]);
  });

  it("in the cloud: no account switching, and the agents the sandbox has", () => {
    const c = limitChoices({ hit, mode: "cloud", model: null, accounts: null, agents: null });
    expect(c.accounts).toEqual([]);
    expect(c.agents).toEqual([{ kind: "codex", model: null }]);
  });

  it("finds the other threads stopped on the same limit", () => {
    const statuses: LocalRunnerStatus[] = [
      { threadId: "a", health: { limit: { agent: "claude-code", account: "work", resetAt: null } } },
      { threadId: "b", health: { limit: { agent: "claude-code", account: "personal", resetAt: null } } },
      { threadId: "c", health: { limit: null } },
      { threadId: "d", health: {} },
      { threadId: "me", health: { limit: { agent: "claude-code", account: "work", resetAt: null } } },
      { threadId: "e", health: { limit: { agent: "codex", account: "work", resetAt: null } } },
    ];
    expect(threadsOnSameLimit(statuses, "me", "claude-code", "work")).toEqual(["a"]);
  });
});
