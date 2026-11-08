import { describe, expect, it } from "vitest";
import { ImportedThreadMeta } from "@lemonlime/protocol";
import { importAgentSessions, mergeImportedThreads, scanAgentHistory } from "../src/lib/history.ts";
import { LocalThreadMeta } from "../src/lib/storage.ts";

const thread = (id: string, updatedAt: string): LocalThreadMeta =>
  LocalThreadMeta.parse(
    ImportedThreadMeta.parse({
      id,
      title: `Thread ${id}`,
      agent: { kind: "claude-code" },
      repoPath: "/work/repo",
      baseBranch: "main",
      branch: `agent/${id}`,
      status: "idle",
      lastSeq: 0,
      createdAt: updatedAt,
      updatedAt,
    }),
  );

describe("imported threads", () => {
  it("are LocalThreadMeta as the runner writes them", () => {
    const t = thread("imported-1", "2026-10-20T09:00:00.000Z");
    expect(t).toMatchObject({ id: "imported-1", repoPath: "/work/repo", branch: "agent/imported-1", lastSeq: 0 });
    expect(t.pendingPrompt).toBeUndefined();
  });

  it("join the list newest first, never twice, leaving existing threads alone", () => {
    const existing = [{ ...thread("existing-1", "2026-10-30T00:00:00.000Z"), lastSeq: 40 }];
    const result = {
      imported: [
        { id: "claude-code:a", thread: thread("imported-1", "2026-10-20T09:00:00.000Z"), already: false },
        { id: "codex:b", thread: thread("imported-2", "2026-10-25T09:00:00.000Z"), already: false },
        { id: "codex:c", thread: { ...thread("existing-1", "2026-10-01T00:00:00.000Z"), lastSeq: 0 }, already: true },
      ],
    };
    const merged = mergeImportedThreads(existing, result);
    expect(merged.map(t => t.id)).toEqual(["imported-2", "imported-1", "existing-1"]);
    expect(merged[2]!.lastSeq).toBe(40);
    expect(mergeImportedThreads(merged, result)).toEqual(merged);
  });

  it("outside the desktop app, a scan is empty and importing nothing does nothing", async () => {
    const scan = await scanAgentHistory(30);
    expect(scan.agents["claude-code"].found).toBe(false);
    expect(scan.sessions).toEqual([]);
    expect(await importAgentSessions([])).toEqual({ imported: [], skipped: [] });
    await expect(importAgentSessions(["codex:x"])).rejects.toThrow(/desktop app/);
  });
});
