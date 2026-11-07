import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { systemStatus } from "@lemonlime/db";
import { sweepRunningSandboxes } from "../src/lib/threads.ts";
import { createTestApp } from "./helpers.ts";

describe("health", () => {
  it("records when the sweep last ran", async () => {
    const { ctx, db } = await createTestApp();
    expect(await db.select().from(systemStatus)).toEqual([]);
    const now = Date.parse("2026-11-07T12:00:00Z");
    await sweepRunningSandboxes(ctx, now);
    const [row] = await db.select().from(systemStatus).where(eq(systemStatus.key, "sweep.last_run"));
    expect(row?.value).toBe("2026-11-07T12:00:00.000Z");
  });
});
