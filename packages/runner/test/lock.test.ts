import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { takeRunnerLock } from "../src/lock.ts";

describe("runner lock", () => {
  it("lets one runner hold a thread, and the next take over once it's gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-lock-"));
    const release = takeRunnerLock(dir);
    expect(readFileSync(join(dir, "runner.lock"), "utf8")).toBe(String(process.pid));
    release();
    // Taken again after release.
    takeRunnerLock(dir)();
  });

  it("refuses while another live runner holds it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-lock-"));
    // The test runner's parent is alive and isn't us: it stands in for another runner.
    writeFileSync(join(dir, "runner.lock"), String(process.ppid));
    expect(() => takeRunnerLock(dir)).toThrow(/already running this thread/);
  });

  it("clears a lock left by a runner that died", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-lock-"));
    writeFileSync(join(dir, "runner.lock"), "999999");
    const release = takeRunnerLock(dir);
    expect(readFileSync(join(dir, "runner.lock"), "utf8")).toBe(String(process.pid));
    release();
  });
});
