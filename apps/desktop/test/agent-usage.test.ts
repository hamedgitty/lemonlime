import { describe, expect, it } from "vitest";
import type { AccountsList, AgentAccount } from "@lemonlime/protocol";
import { dueForRefresh, usageRows, usageTone, USAGE_REFRESH_MS } from "../src/lib/agentUsage.ts";
import { isMissingFolderError } from "../src/lib/missingFolders.ts";

const observedAt = "2026-11-08T12:00:00.000Z";
const account = (o: Partial<AgentAccount> = {}): AgentAccount => ({
  id: "default",
  label: "Default",
  builtIn: true,
  isDefault: true,
  signedIn: true,
  ...o,
});
const usage = (five: number, seven: number) => ({
  observedAt,
  windows: [
    { kind: "seven_day" as const, label: "7d", usedPercent: seven },
    { kind: "five_hour" as const, label: "5h", usedPercent: five },
  ],
});
const list = (claude: AgentAccount[], codex: AgentAccount[] = []): AccountsList => ({ onLimit: "ask", agents: { "claude-code": claude, codex } });

describe("usage card", () => {
  it("is empty when no agent reports usage", () => {
    expect(usageRows(null)).toEqual([]);
    expect(usageRows(list([account()], [account()]))).toEqual([]);
  });

  it("lists each signed-in agent's 5h then 7d limits", () => {
    const rows = usageRows(list([account({ usage: usage(40, 10) })], [account({ usage: usage(95, 60) })]));
    expect(rows.map(r => r.agent)).toEqual(["claude-code", "codex"]);
    expect(rows[0]!.windows.map(w => w.label)).toEqual(["5h", "7d"]);
    expect(rows[0]!.account).toBeUndefined();
    expect(rows[1]!.windows[0]!.usedPercent).toBe(95);
  });

  it("uses the account in use, naming it when there are several", () => {
    const rows = usageRows(
      list([
        account({ id: "default", isDefault: false, usage: usage(80, 20), email: "home@example.com" }),
        account({ id: "work", builtIn: false, isDefault: true, usage: usage(5, 1), email: "work@example.com" }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "claude-code", account: "work@example.com" });
    expect(rows[0]!.windows[0]!.usedPercent).toBe(5);
  });

  it("skips accounts that aren't signed in, falling back to one that is", () => {
    const rows = usageRows(
      list([account({ signedIn: false, usage: usage(50, 50) }), account({ id: "b", isDefault: false, builtIn: false, usage: usage(20, 30) })]),
    );
    expect(rows[0]!.windows[0]!.usedPercent).toBe(20);
    expect(usageRows(list([account({ signedIn: false, usage: usage(50, 50) })]))).toEqual([]);
  });

  it("shows another window only when neither 5h nor 7d is reported", () => {
    const rows = usageRows(list([account({ usage: { observedAt, windows: [{ kind: "other", label: "Opus", usedPercent: 12 }] } })]));
    expect(rows[0]!.windows.map(w => w.label)).toEqual(["Opus"]);
    const mixed = usageRows(list([account({ usage: { observedAt, windows: [{ kind: "other", label: "Opus", usedPercent: 12 }, ...usage(1, 2).windows] } })]));
    expect(mixed[0]!.windows.map(w => w.label)).toEqual(["5h", "7d"]);
  });

  it("colours the bar by how full it is", () => {
    expect([0, 69, 70, 89, 90, 100].map(usageTone)).toEqual(["ok", "ok", "high", "high", "full", "full"]);
  });

  it("asks again at most every two minutes", () => {
    expect(dueForRefresh(null, 0)).toBe(true);
    expect(dueForRefresh(1000, 1000 + USAGE_REFRESH_MS - 1)).toBe(false);
    expect(dueForRefresh(1000, 1000 + USAGE_REFRESH_MS)).toBe(true);
  });
});

describe("missing project folders", () => {
  it("tells a missing folder from other problems", () => {
    expect(isMissingFolderError("/code/app is not a folder.")).toBe(true);
    expect(isMissingFolderError(new Error("/code/app is not a folder."))).toBe(true);
    expect(isMissingFolderError("This folder is not a git repository. Run `git init` in it first, or pick another folder.")).toBe(false);
  });
});
