import { afterEach, describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { buildTimeline, foldFinishedTurns, personTexts, waitingOnYou, writtenByPerson } from "../src/lib/timeline.ts";
import { liveTurnStart, tocEntries } from "../src/lib/timelineView.ts";
import { continuableRestart } from "../src/lib/recovery.ts";
import { forkNote } from "../src/lib/messageActions.ts";
import { forkPrompt } from "../src/lib/threadMenu.ts";
import { loadMessageTexts, saveEvents } from "../src/lib/storage.ts";
import { betterTitle } from "../src/lib/threadTitle.ts";
import { uniquePrompts } from "../src/lib/promptHistory.ts";
import { rowGap } from "../src/lib/steps.ts";
import { firstMessageArrived } from "../src/lib/backgroundStart.ts";

const threadId = "abc123-thread";
const events = (list: NewEvent[]): ThreadEvent[] =>
  list.map((e, i) => ThreadEvent.parse({ ...e, threadId, at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, seq: i + 1 }));

const report = "The tests pass now.\n\nI changed sum.js and added two cases.";
const carryOn = "Continue where you left off.";

/** A person asks, the agent hands work to a subagent, the report comes back, then the runner carries on by itself. */
const history = () =>
  events([
    { type: "user_message", text: "hi" },
    { type: "agent_message", text: "Handing this to a subagent.", partial: false },
    { type: "status_change", from: "running", to: "idle" },
    { type: "user_message", text: report, from: "subagent" },
    { type: "agent_message", text: "The subagent is done.", partial: false },
    { type: "status_change", from: "running", to: "idle" },
    { type: "user_message", text: carryOn, from: "runner" },
    { type: "agent_message", text: "Carrying on.", partial: false },
  ]);

describe("messages nobody typed", () => {
  it("show as a subagent's report and a line from the runner, not as messages from the user", () => {
    const items = buildTimeline(history());
    expect(items.filter(i => i.kind === "user").map(i => i.text)).toEqual(["hi"]);
    expect(items.filter(i => i.kind === "auto")).toMatchObject([
      { from: "subagent", text: report, seq: 4 },
      { from: "runner", text: carryOn, seq: 7 },
    ]);
  });

  it("change nothing for a runner that doesn't say who wrote a message", () => {
    const items = buildTimeline(
      events([
        { type: "user_message", text: "hi" },
        { type: "user_message", text: report },
      ]),
    );
    expect(items.map(i => i.kind)).toEqual(["user", "user"]);
  });

  it("are told apart from what a person wrote", () => {
    const [mine, , , theirs, , , runners] = history();
    expect(writtenByPerson(mine!)).toBe(true);
    expect(writtenByPerson(theirs!)).toBe(false);
    expect(writtenByPerson(runners!)).toBe(false);
  });

  it("can't be edited, gone back to or queued, because they aren't the user's rows", () => {
    const items = buildTimeline(history());
    const auto = items.filter(i => i.kind === "auto");
    for (const row of auto) expect("pending" in row || "restorable" in row || "queued" in row).toBe(false);
    expect(waitingOnYou(items).queued).toEqual([]);
  });

  it("still drop the copy the app was waiting to hear back, when one carries the app's own id", () => {
    const items = buildTimeline(events([{ type: "user_message", text: carryOn, from: "runner", clientMsgId: "auto-continue-1" }]), [
      { clientMsgId: "auto-continue-1", text: carryOn, at: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(items.map(i => i.kind)).toEqual(["auto"]);
  });

  it("leave a plan open: only a reply from a person settles it", () => {
    const plan: NewEvent = { type: "plan_proposal", plan: "1. Do the thing" };
    const open = buildTimeline(events([{ type: "user_message", text: "plan it" }, plan, { type: "user_message", text: report, from: "subagent" }]));
    expect(open.find(i => i.kind === "plan")).toMatchObject({ open: true });
    const settled = buildTimeline(events([{ type: "user_message", text: "plan it" }, plan, { type: "user_message", text: "no, do it another way" }]));
    expect(settled.find(i => i.kind === "plan")).toMatchObject({ open: false });
  });

  it("start a turn, so earlier turns fold and the working clock runs from them", () => {
    const items = buildTimeline([...history(), ...events([{ type: "tool_call", callId: "c1", name: "Read", input: {} }]).map(e => ({ ...e, seq: 20 }))]);
    expect(liveTurnStart(items)).toBe("2026-01-01T00:00:06.000Z");
    const rows = foldFinishedTurns(items);
    // Each turn keeps the message that started it and the agent's reply to it.
    expect(rows.filter(r => r.kind === "user" || r.kind === "auto" || r.kind === "agent").map(r => r.kind)).toEqual([
      "user",
      "agent",
      "auto",
      "agent",
      "auto",
      "agent",
    ]);
    expect(rowGap("agent", "auto")).toBe("turn");
  });

  it("are left out of the list of the user's messages, but still end the agent's turn there", () => {
    const toc = tocEntries(buildTimeline(history()));
    expect(toc.you.map(e => e.label)).toEqual(["hi"]);
    expect(toc.agent.map(e => e.label)).toEqual(["Handing this to a subagent.", "The subagent is done.", "Carrying on."]);
  });

  it("don't name the thread or fill the composer's history of earlier prompts", () => {
    const texts = personTexts(history());
    expect(texts).toEqual(["hi"]);
    expect(uniquePrompts(texts)).toEqual(["hi"]);
    // "hi" stays the title: the report that followed isn't something the user asked for.
    expect(betterTitle("hi", texts)).toBeNull();
    expect(betterTitle("hi", [...texts, "Fix the failing sum test"])).toBe("Fix the failing sum test");
  });

  it("aren't quoted as the request a thread started with when it is forked", () => {
    const list = events([
      { type: "user_message", text: carryOn, from: "runner" },
      { type: "user_message", text: "Fix sum.js" },
    ]);
    const prompt = forkPrompt({ title: "Sums", branch: "agent/abc" }, list);
    expect(prompt).toContain("> Fix sum.js");
    expect(prompt).not.toContain(carryOn);
  });

  it("go into a fork's notes as a subagent's report, never as the user speaking", () => {
    const items = buildTimeline(history());
    const last = items.findLast(i => i.kind === "agent")!;
    const note = forkNote(items, { key: last.key }, { title: "Sums", branch: "agent/abc", baseBranch: "main" })!;
    expect(note).toContain("**User:**\n\nhi");
    expect(note).toContain(`**Subagent report:**\n\n${report}`);
    expect(note).not.toContain(`**User:**\n\n${report}`);
    expect(note).not.toContain(carryOn);
  });

  it("mean the runner has carried on, so Continue isn't offered again", () => {
    const cut: NewEvent = { type: "error", message: "The runner restarted.", code: "turn_outcome_unknown", fatal: false };
    const waiting = buildTimeline(events([{ type: "user_message", text: "hi" }, cut]));
    expect(continuableRestart(waiting)).not.toBeNull();
    const carried = buildTimeline(events([{ type: "user_message", text: "hi" }, cut, { type: "user_message", text: carryOn, from: "runner" }]));
    expect(continuableRestart(carried)).toBeNull();
  });

  it("don't count as a new thread's first message having arrived", () => {
    expect(firstMessageArrived(events([{ type: "user_message", text: carryOn, from: "runner" }]))).toBe(false);
    expect(firstMessageArrived(events([{ type: "user_message", text: "hi" }]))).toBe(true);
  });

  describe("in search", () => {
    afterEach(() => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it("aren't listed as something you said", () => {
      const store = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };
      saveEvents(threadId, history());
      expect(loadMessageTexts(threadId).filter(m => m.from === "you")).toEqual([{ seq: 1, from: "you", text: "hi" }]);
      expect(loadMessageTexts(threadId).some(m => m.text === report || m.text === carryOn)).toBe(false);
    });
  });
});
