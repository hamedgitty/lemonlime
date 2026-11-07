import type { UsageNotice, UsageSummary } from "@lemonlime/plugins";
import type { AppContext } from "./context.ts";

/** The usage policy's banner for a workspace. A failing policy shows nothing rather than breaking the page. */
export async function usageNotice(ctx: AppContext, userId: string, workspaceId: string): Promise<UsageNotice | null> {
  const policy = ctx.plugin.usagePolicy;
  if (!policy.notice) return null;
  try {
    return await policy.notice({ userId, workspaceId });
  } catch (err) {
    console.error("[lemonlime] usage notice failed:", err);
    return null;
  }
}

/** The usage policy's sidebar card for a workspace, the same way. */
export async function usageSummary(ctx: AppContext, userId: string, workspaceId: string): Promise<UsageSummary | null> {
  const policy = ctx.plugin.usagePolicy;
  if (!policy.summary) return null;
  try {
    const s = await policy.summary({ userId, workspaceId });
    return s && typeof s.progress === "number" ? { ...s, progress: Math.min(1, Math.max(0, s.progress)) } : s;
  } catch (err) {
    console.error("[lemonlime] usage summary failed:", err);
    return null;
  }
}
