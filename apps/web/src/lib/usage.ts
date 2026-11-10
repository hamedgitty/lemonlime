import type { UsageNotice, UsageSummary } from "@lemonlime/plugins";
import type { AppContext } from "./context.ts";
import { withSafeLink } from "./links.ts";

/**
 * The usage policy's banner for a workspace. A failing policy shows nothing rather than
 * breaking the page, and a link that isn't safe to offer is left out.
 */
export async function usageNotice(ctx: AppContext, userId: string, workspaceId: string): Promise<UsageNotice | null> {
  const policy = ctx.plugin.usagePolicy;
  if (!policy.notice) return null;
  try {
    const notice = await policy.notice({ userId, workspaceId });
    return notice && withSafeLink(notice);
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
    const given = await policy.summary({ userId, workspaceId });
    const s = given && withSafeLink(given);
    return s && typeof s.progress === "number" ? { ...s, progress: Math.min(1, Math.max(0, s.progress)) } : s;
  } catch (err) {
    console.error("[lemonlime] usage summary failed:", err);
    return null;
  }
}
