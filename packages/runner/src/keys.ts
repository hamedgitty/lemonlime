import { connect } from "node:net";
import { deriveAgentKey, signToken, verifyToken, type VerifyResult } from "@lemonlime/protocol";

/**
 * What the runner does with the thread secret, behind one interface so the secret itself
 * can live somewhere the agent can't read (the keeper, see keeper.ts).
 */
export interface ThreadKeys {
  /** Check a token signed with the thread secret (the user's apps, the control plane's relay). */
  verify(token: string): Promise<VerifyResult>;
  /** A runner token for this thread, for talking to the control plane. At most 10 minutes. */
  signRunner(seconds: number): Promise<string>;
  /** The key the agent's own tools sign with (see deriveAgentKey). */
  agentKey: string;
}

export const MAX_RUNNER_TOKEN_SECONDS = 600;

/** Keys held in this process: the runner was given the secret directly. */
export async function keysFromSecret(threadId: string, secret: string): Promise<ThreadKeys> {
  return {
    verify: token => verifyToken(token, secret),
    signRunner: seconds =>
      signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + Math.min(Math.max(1, seconds), MAX_RUNNER_TOKEN_SECONDS) }, secret),
    agentKey: await deriveAgentKey(secret),
  };
}

/** One request to the keeper over its socket: a line of JSON out, a line of JSON back. */
export function keeperCall<T>(socket: string, request: Record<string, unknown>, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("the keeper didn't answer"));
    }, timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify(request) + "\n"));
    conn.on("data", d => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      conn.end();
      try {
        const answer = JSON.parse(buf.slice(0, nl)) as { error?: string } & T;
        if (answer.error) reject(new Error(answer.error));
        else resolve(answer);
      } catch (err) {
        reject(err as Error);
      }
    });
    conn.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Keys held by the keeper: this runner never sees the secret. */
export async function keysFromKeeper(socket: string): Promise<ThreadKeys> {
  const { agentKey } = await keeperCall<{ agentKey: string }>(socket, { op: "agentKey" });
  return {
    verify: token => keeperCall<{ result: VerifyResult }>(socket, { op: "verify", token }).then(r => r.result),
    signRunner: seconds => keeperCall<{ token: string }>(socket, { op: "sign", seconds }).then(r => r.token),
    agentKey,
  };
}
