import { eq } from "drizzle-orm";
import { systemStatus } from "@lemonlime/db";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** The sweep runs every minute; this long without one means something is wrong. */
const SWEEP_STALE_MS = 5 * 60_000;

/**
 * For uptime monitors: 200 when the database answers and the idle sweep ran recently,
 * 503 otherwise, with which check failed. Public, and says nothing about anyone's data.
 */
export const GET = route(async () => {
  const ctx = await getAppContext();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  let lastSweep: string | null = null;
  try {
    const [row] = await ctx.db.select().from(systemStatus).where(eq(systemStatus.key, "sweep.last_run"));
    lastSweep = row?.value ?? null;
    checks.database = { ok: true };
  } catch (err) {
    // The error itself goes to the logs only: it can name files or hosts.
    console.error("health: database check failed", err);
    checks.database = { ok: false, detail: "not answering" };
  }
  const age = lastSweep ? Date.now() - Date.parse(lastSweep) : Number.POSITIVE_INFINITY;
  checks.sweep =
    age <= SWEEP_STALE_MS ? { ok: true } : { ok: false, detail: lastSweep ? `last ran ${Math.round(age / 60_000)} minutes ago` : "has not run yet" };
  checks.history = ctx.history ? { ok: true } : { ok: false, detail: "no history storage set up" };
  // History storage is optional, so it doesn't make the service unhealthy.
  const ok = checks.database.ok && checks.sweep.ok;
  return json({ ok, lastSweep, checks }, ok ? 200 : 503);
});
