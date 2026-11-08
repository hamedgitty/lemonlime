import { describe, expect, it } from "vitest";
import { LocalThreadSnapshot } from "@lemonlime/protocol";
import { computerPlatform, helloForRunner, threadSnapshots } from "../src/lib/phoneBridge.ts";
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
