import type { UsageNotice } from "@lemonlime/plugins";
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
