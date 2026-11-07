import { and, inArray, isNotNull, eq } from "drizzle-orm";
import { RelayPoll, signToken, type RelayAnswer } from "@lemonlime/protocol";
import { threads } from "@lemonlime/db";
import type { AppContext } from "./context.ts";
import { threadSecret } from "./tokens.ts";

/**
 * Relay mode, for sandbox providers that only let sandboxes reach a list of well-known
 * hosts (so the runner can't call this control plane): runners started with `--relay`
 * keep their calls, and this collects them every minute, makes them here and hands back
 * the answers. Turned on with LEMONLIME_RUNNER_RELAY=true.
 */
export function relayEnabled(vars: Record<string, string | undefined>): boolean {
  return vars.LEMONLIME_RUNNER_RELAY === "true";
}

/** Makes one relayed call on this control plane: the same route a runner would have reached. */
export type RunnerCallDispatch = (request: Request) => Promise<Response>;

export interface RelayResult {
  threads: number;
  calls: number;
  errors: Array<{ threadId: string; error: string }>;
}

/** Rounds per thread: answering a call often makes the runner ask the next (history, then heartbeat, then messages). */
const ROUNDS = 4;
const ROUND_GAP_MS = 1500;
const FETCH_TIMEOUT_MS = 10_000;
const PARALLEL = 8;

export async function relayRunnerCalls(
  ctx: AppContext,
  dispatch: RunnerCallDispatch,
  opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RelayResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const rows = await ctx.db
    .select({ id: threads.id, runnerUrl: threads.runnerUrl })
    .from(threads)
    .where(
      and(
        eq(threads.mode, "cloud"),
        isNotNull(threads.runnerUrl),
        isNotNull(threads.runningSince),
        inArray(threads.status, ["provisioning", "idle", "running"]),
      ),
    );
  const result: RelayResult = { threads: rows.length, calls: 0, errors: [] };
  const base = ctx.config.publicUrl().replace(/\/+$/, "");

  const relayOne = async (row: { id: string; runnerUrl: string | null }) => {
    const runner = row.runnerUrl!.replace(/\/+$/, "");
    const secret = await threadSecret(ctx.config.tokenSecret(), row.id);
    for (let round = 0; round < ROUNDS; round++) {
      const token = await signToken({ threadId: row.id, scope: "relay", exp: Math.floor(Date.now() / 1000) + 120 }, secret);
      // Some providers put a warning page in front of preview links unless told not to.
      const headers = { authorization: `Bearer ${token}`, "x-daytona-skip-preview-warning": "true" };
      const polled = await doFetch(`${runner}/relay`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!polled.ok) throw new Error(`collecting calls: HTTP ${polled.status}`);
      const poll = RelayPoll.safeParse(await polled.json().catch(() => null));
      if (!poll.success) throw new Error("collecting calls: unexpected reply");
      if (poll.data.requests.length === 0) return;
      const answers: RelayAnswer[] = [];
      for (const call of poll.data.requests) {
        const res = await dispatch(
          new Request(`${base}${call.path}`, {
            method: call.method,
            headers: { authorization: call.authorization, "content-type": "application/json" },
            ...(call.method === "POST" ? { body: JSON.stringify(call.body ?? {}) } : {}),
          }),
        ).catch(() => new Response(JSON.stringify({ error: "internal" }), { status: 500 }));
        answers.push({ id: call.id, status: res.status, body: await res.json().catch(() => null) });
      }
      result.calls += answers.length;
      const sent = await doFetch(`${runner}/relay`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ answers }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!sent.ok) throw new Error(`answering calls: HTTP ${sent.status}`);
      if (round < ROUNDS - 1) await sleep(ROUND_GAP_MS);
    }
  };

  for (let i = 0; i < rows.length; i += PARALLEL) {
    await Promise.all(
      rows.slice(i, i + PARALLEL).map(row =>
        relayOne(row).catch(err => {
          result.errors.push({ threadId: row.id, error: err instanceof Error ? err.message : String(err) });
        }),
      ),
    );
  }
  return result;
}
