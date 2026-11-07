import { describe, expect, it } from "vitest";
import { allowAllPolicy, defaultPlugin, definePlugin, loadPlugin, renderSlot, resolvePlugin, type UsagePolicy } from "../src/index.ts";

const req = { userId: "u", workspaceId: "w", threadId: "abc123", size: "small" as const };

describe("defaults", () => {
  it("allow everything", async () => {
    expect(await allowAllPolicy.canStartSandbox(req)).toEqual({ allow: true });
    expect(await allowAllPolicy.canKeepRunning({ ...req, sandboxId: "s", runningSince: new Date().toISOString() })).toEqual({ allow: true });
  });

  it("render nothing", () => {
    expect(renderSlot(defaultPlugin.billingUI.accountSection, { workspaceId: "w" })).toBeNull();
  });
});

describe("resolving plugins", () => {
  it("fills missing hooks with defaults", () => {
    const deny: UsagePolicy = { ...allowAllPolicy, canStartSandbox: async () => ({ allow: false, reason: "no" }) };
    const p = resolvePlugin(definePlugin({ name: "test", usagePolicy: deny }));
    expect(p.usagePolicy).toBe(deny);
    expect(p.billingUI).toEqual({});
  });

  it("returns defaults for an empty specifier", async () => {
    expect(await loadPlugin(undefined)).toBe(defaultPlugin);
    expect(await loadPlugin("  ")).toBe(defaultPlugin);
  });

  it("loads a plugin's default export", async () => {
    const p = await loadPlugin("some-plugin", async () => ({ default: { name: "custom" } }));
    expect(p.name).toBe("custom");
    expect(p.usagePolicy).toBe(allowAllPolicy);
  });

  it("builds factory plugins from the runtime env", () => {
    const p = resolvePlugin(
      definePlugin(({ env }) => ({ name: `plugin-${String(env.REGION)}` })),
      { env: { REGION: "eu" } },
    );
    expect(p.name).toBe("plugin-eu");
    expect(p.usagePolicy).toBe(allowAllPolicy);
  });

  it("fails loudly when a configured plugin is broken", async () => {
    await expect(loadPlugin("broken", async () => ({}))).rejects.toThrow(/no default export/);
  });
});
