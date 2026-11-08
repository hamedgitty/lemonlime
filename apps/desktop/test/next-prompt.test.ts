import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@lemonlime/protocol";
import { suggestNextPrompt } from "../src/lib/nextPrompt.ts";
import { otherProjectMentioned } from "../src/lib/projectHint.ts";

let seq = 0;
const at = "2026-11-08T10:00:00.000Z";
const threadId = "t1";
const ev = (e: Record<string, unknown>) => ({ threadId, seq: ++seq, at, ...e }) as ThreadEvent;
const user = (text: string) => ev({ type: "user_message", text });
const agent = (text: string) => ev({ type: "agent_message", text, partial: false });
const call = (callId: string, input: unknown) => ev({ type: "tool_call", callId, name: "Bash", input });
const result = (callId: string, output: unknown, isError = false) => ev({ type: "tool_result", callId, output, isError });
const diff = (path: string) => ev({ type: "file_diff", path, change: "modified", diff: "", truncated: false });

describe("suggested next prompt", () => {
  it("says nothing before the first message or after a plain answer", () => {
    expect(suggestNextPrompt([])).toBeNull();
    expect(suggestNextPrompt([user("What does this do?"), agent("It parses the config.")])).toBeNull();
  });

  it("says yes when the agent offers to do something", () => {
    expect(suggestNextPrompt([user("Look at the login bug"), agent("Found it: the token is never refreshed.\n\nWant me to fix it and add a test?")])).toBe(
      "Yes, go ahead",
    );
    expect(suggestNextPrompt([user("x"), agent("Should I also update the docs?")])).toBe("Yes, go ahead");
    expect(suggestNextPrompt([user("x"), agent("Done. Let me know if you'd like me to open a pull request.")])).toBe("Yes, go ahead");
  });

  it("leaves other questions for the person to answer", () => {
    expect(suggestNextPrompt([user("x"), agent("Which database are you using?")])).toBeNull();
  });

  it("offers to implement a waiting plan", () => {
    expect(suggestNextPrompt([user("Plan the refactor"), ev({ type: "plan_proposal", plan: "1. Split the file" }), agent("Here's the plan.")])).toBe(
      "Implement the plan",
    );
  });

  it("offers to fix tests that failed in the last turn, but not ones fixed since", () => {
    const failing = [user("Add the feature"), call("c1", { command: "pnpm test" }), result("c1", "Tests  2 failed | 40 passed"), agent("Two tests fail.")];
    expect(suggestNextPrompt(failing)).toBe("Fix the failing tests");
    expect(
      suggestNextPrompt([user("x"), call("c2", { command: ["cargo", "test"] }), result("c2", "test result: FAILED. 1 passed; 1 failed"), agent("Hmm.")]),
    ).toBe("Fix the failing tests");
    const fixed = [...failing, call("c3", { command: "pnpm test" }), result("c3", "Tests  42 passed"), agent("All green now.")];
    expect(suggestNextPrompt(fixed)).toBeNull();
    // A failed command that isn't a test run doesn't count.
    expect(suggestNextPrompt([user("x"), call("c4", { command: "ls nope" }), result("c4", "No such file", true), agent("That folder is missing.")])).toBeNull();
    // Only the last turn counts.
    expect(suggestNextPrompt([...failing, user("Never mind"), agent("OK.")])).toBeNull();
  });

  it("suggests committing finished work that isn't committed", () => {
    const done = [user("Rename the helper"), diff("src/a.ts"), agent("Renamed it everywhere.")];
    expect(suggestNextPrompt(done, { uncommittedFiles: 1 })).toBe("Commit this");
    expect(suggestNextPrompt(done, { uncommittedFiles: 0 })).toBeNull();
    expect(suggestNextPrompt(done)).toBeNull();
  });

  it("stays quiet while the agent waits for an answer, and offers a retry after an error", () => {
    expect(suggestNextPrompt([user("x"), ev({ type: "approval_request", id: "a1", tool: "Bash", summary: "rm" })])).toBeNull();
    expect(suggestNextPrompt([user("x"), ev({ type: "error", message: "Overloaded", code: "overloaded", fatal: false })])).toBe("Try that again");
    expect(suggestNextPrompt([user("x"), ev({ type: "error", message: "Log in", code: "auth_required", fatal: false })])).toBeNull();
  });
});

describe("wrong-project hint", () => {
  const projects = ["/Users/me/code/lemonlime", "/Users/me/code/billing-service", "/Users/me/code/api", "/Users/me/code/web", "/Users/me/code/billing"];
  const current = "/Users/me/code/lemonlime";

  it("names another project mentioned by its folder name, as a whole word", () => {
    expect(otherProjectMentioned("Fix the retry bug in billing-service", projects, current)).toBe("/Users/me/code/billing-service");
    expect(otherProjectMentioned("fix BILLING totals", projects, current)).toBe("/Users/me/code/billing");
  });

  it("ignores parts of words, everyday names, and the chosen project", () => {
    expect(otherProjectMentioned("rebilling is broken", projects, current)).toBeNull();
    expect(otherProjectMentioned("the billings page", projects, current)).toBeNull();
    expect(otherProjectMentioned("update the api docs on the web", projects, current)).toBeNull();
    expect(otherProjectMentioned("Port billing's fix into lemonlime", projects, current)).toBeNull();
    expect(otherProjectMentioned("", projects, current)).toBeNull();
    expect(otherProjectMentioned("look at billing", projects, "/Users/me/code/billing")).toBeNull();
  });

  it("isn't fooled by file names", () => {
    expect(otherProjectMentioned("open billing.ts", projects, current)).toBeNull();
    expect(otherProjectMentioned("Is billing.", projects, current)).toBe("/Users/me/code/billing");
  });
});
