import type { AppContext } from "./context.ts";

/** The deployment plugin's periodic work, run with every sweep. A failure is logged, never thrown. */
export async function runPluginSchedule(ctx: AppContext, now = Date.now()): Promise<void> {
  try {
    await ctx.plugin.events.onSchedule?.(now);
  } catch (err) {
    console.error("[lemonlime] plugin onSchedule failed:", err);
  }
}
