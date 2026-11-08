import { signToken } from "@lemonlime/protocol";
import { RUNNER_SCRIPT, selfCommand } from "./self.ts";

/** The runner's own entry point, for git to call back into (when running from source). */
export const RUNNER_BIN = RUNNER_SCRIPT;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `credential.helper` value that makes git ask this runner for credentials. */
export function credentialHelperCommand(command: string[] = selfCommand("git-credential")): string {
  return `!${command.map(q).join(" ")}`;
}

/**
 * `lemonlime-runner git-credential get`: git's credential helper protocol. Reads the
 * request on stdin, asks the control plane for a fresh token for this thread's repository,
 * and prints it. Prints nothing when there is none, so git carries on without (public
 * repos). `store` and `erase` are ignored: tokens expire on their own within the hour.
 *
 * Needs LEMONLIME_THREAD_ID, LEMONLIME_AGENT_KEY and LEMONLIME_CONTROL_PLANE_URL, which
 * the runner sets for itself and everything it starts.
 *
 * Relay mode (the sandbox can't reach the control plane): the control plane hands the
 * sandbox a first token when it starts (LEMONLIME_GIT_TOKEN, for LEMONLIME_GIT_HOST, until
 * LEMONLIME_GIT_TOKEN_EXPIRES), used while it lasts, so the first clone doesn't wait; after
 * that the request goes through the runner (LEMONLIME_RUNNER_URL), which relays it.
 */
export async function gitCredential(op: string, input: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (op !== "get") return "";
  const req = Object.fromEntries(
    input
      .split("\n")
      .map(l => l.split("="))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => [k!.trim(), v.join("=").trim()]),
  );
  if (req.protocol !== "https" || !req.host) return "";
  const threadId = env.LEMONLIME_THREAD_ID;
  // The agent's key (see deriveAgentKey); the control plane accepts it for this one request.
  const secret = env.LEMONLIME_AGENT_KEY;
  const base = env.LEMONLIME_CONTROL_PLANE_URL;
  if (!threadId || !secret || !base) return "";
  const startToken = env.LEMONLIME_GIT_TOKEN;
  const startUntil = Date.parse(env.LEMONLIME_GIT_TOKEN_EXPIRES ?? "");
  if (startToken && (env.LEMONLIME_GIT_HOST ?? "").toLowerCase() === req.host.toLowerCase() && startUntil - Date.now() > 5 * 60_000)
    return `username=x-access-token\npassword=${startToken}\n`;
  const path = `/api/runner/git-credentials?threadId=${encodeURIComponent(threadId)}&host=${encodeURIComponent(req.host)}`;
  const relayed = env.LEMONLIME_RELAY === "1" && env.LEMONLIME_RUNNER_URL;
  const token = await signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + (relayed ? 300 : 120) }, secret);
  const res = await (
    relayed
      ? fetch(`${env.LEMONLIME_RUNNER_URL!.replace(/\/+$/, "")}/relay/local`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ path }),
          // The control plane collects relayed calls every minute.
          signal: AbortSignal.timeout(200_000),
        })
      : fetch(`${base.replace(/\/+$/, "")}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        })
  ).catch(() => null);
  if (!res?.ok) return "";
  const body = (await res.json().catch(() => ({}))) as { username?: string; password?: string };
  if (!body.username || !body.password) return "";
  return `username=${body.username}\npassword=${body.password}\n`;
}
