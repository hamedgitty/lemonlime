import { fileURLToPath } from "node:url";
import { signToken } from "@lemonlime/protocol";

/** The runner's own entry point, for git to call back into. */
export const RUNNER_BIN = fileURLToPath(new URL("../bin/lemonlime-runner.js", import.meta.url));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `credential.helper` value that makes git ask this runner for credentials. */
export function credentialHelperCommand(node = process.execPath, bin = RUNNER_BIN): string {
  return `!${q(node)} ${q(bin)} git-credential`;
}

/**
 * `lemonlime-runner git-credential get`: git's credential helper protocol. Reads the
 * request on stdin, asks the control plane for a fresh token for this thread's repository,
 * and prints it. Prints nothing when there is none, so git carries on without (public
 * repos). `store` and `erase` are ignored: tokens expire on their own within the hour.
 *
 * Needs LEMONLIME_THREAD_ID, LEMONLIME_THREAD_SECRET and LEMONLIME_CONTROL_PLANE_URL, which
 * the runner sets for itself and everything it starts.
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
  if (req.protocol !== "https") return "";
  const threadId = env.LEMONLIME_THREAD_ID;
  const secret = env.LEMONLIME_THREAD_SECRET;
  const base = env.LEMONLIME_CONTROL_PLANE_URL;
  if (!threadId || !secret || !base) return "";
  const token = await signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + 120 }, secret);
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/runner/git-credentials?threadId=${encodeURIComponent(threadId)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) return "";
  const body = (await res.json().catch(() => ({}))) as { username?: string; password?: string };
  if (!body.username || !body.password) return "";
  return `username=${body.username}\npassword=${body.password}\n`;
}
