import { describe, expect, it } from "vitest";
import { usageNotice, usageSummary } from "../src/lib/usage.ts";
import { createTestApp } from "./helpers.ts";

describe("usage notice", () => {
  it("shows nothing when self-hosting, the policy's banner otherwise, and nothing if it fails", async () => {
    expect(await usageNotice((await createTestApp()).ctx, "u", "w")).toBeNull();
    const low = await createTestApp({
      policy: { notice: async () => ({ level: "warning", message: "Running low", actionUrl: "https://example.com/up", actionLabel: "Add hours" }) },
    });
    expect(await usageNotice(low.ctx, "u", "w")).toMatchObject({ level: "warning", message: "Running low" });
    const broken = await createTestApp({
      policy: {
        notice: async () => {
          throw new Error("ledger down");
        },
      },
    });
    expect(await usageNotice(broken.ctx, "u", "w")).toBeNull();
  });

  it("gives the sidebar card when the deployment has one, kept to a 0-1 bar", async () => {
    expect(await usageSummary((await createTestApp()).ctx, "u", "w")).toBeNull();
    const app = await createTestApp({ policy: { summary: async () => ({ title: "Cloud hours", detail: "143 of 200 left", progress: 1.4 }) } });
    expect(await usageSummary(app.ctx, "u", "w")).toEqual({ title: "Cloud hours", detail: "143 of 200 left", progress: 1 });
  });
});
