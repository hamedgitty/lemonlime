import { and, eq } from "drizzle-orm";
import { agentCredentials } from "@lemonlime/db";
import { isAllowedAgentCredential, type AgentCredentialUpload } from "@lemonlime/protocol";
import type { AppContext } from "./context.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

/** Encryption scope: a credential belongs to one user and one agent. */
const scope = (userId: string, agent: string) => `agent:${userId}:${agent}`;

/** Keep (or replace) what a user's sign-in produced inside a sandbox. */
export async function saveAgentCredential(ctx: AppContext, userId: string, c: Pick<AgentCredentialUpload, "agent" | "kind" | "name" | "value">): Promise<void> {
  if (!isAllowedAgentCredential(c.agent, c.kind, c.name)) throw new Error(`Not a ${c.agent} credential: ${c.kind} ${c.name}`);
  const ciphertext = await encryptSecret(ctx, scope(userId, c.agent), `${c.kind}:${c.name}`, c.value);
  await ctx.db
    .insert(agentCredentials)
    .values({ userId, agent: c.agent, kind: c.kind, name: c.name, ciphertext })
    .onConflictDoUpdate({
      target: [agentCredentials.userId, agentCredentials.agent, agentCredentials.name],
      set: { kind: c.kind, ciphertext, updatedAt: new Date().toISOString() },
    });
}

/** Which agents a user has signed in from LemonLime (names only). */
export async function listAgentSignIns(ctx: AppContext, userId: string): Promise<{ agent: string; updatedAt: string }[]> {
  const rows = await ctx.db
    .select({ agent: agentCredentials.agent, updatedAt: agentCredentials.updatedAt })
    .from(agentCredentials)
    .where(eq(agentCredentials.userId, userId));
  return rows;
}

export async function forgetAgentSignIn(ctx: AppContext, userId: string, agent: string): Promise<void> {
  await ctx.db.delete(agentCredentials).where(and(eq(agentCredentials.userId, userId), eq(agentCredentials.agent, agent)));
}

/** A user's sign-in for one agent, decrypted, for a new sandbox. Unreadable entries are skipped. */
export async function credentialsForSandbox(
  ctx: AppContext,
  userId: string | null,
  agent: string,
): Promise<{ env: Record<string, string>; files: Record<string, string> }> {
  const out = { env: {} as Record<string, string>, files: {} as Record<string, string> };
  if (!userId) return out;
  const rows = await ctx.db
    .select()
    .from(agentCredentials)
    .where(and(eq(agentCredentials.userId, userId), eq(agentCredentials.agent, agent)));
  for (const r of rows) {
    // Saved before the allowlist existed, or written some other way: never hand it out.
    if (!isAllowedAgentCredential(agent, r.kind, r.name)) continue;
    try {
      const value = await decryptSecret(ctx, scope(userId, agent), `${r.kind}:${r.name}`, r.ciphertext);
      if (r.kind === "env") out.env[r.name] = value;
      else out.files[r.name] = value;
    } catch {
      console.warn(`[lemonlime] a saved ${agent} sign-in could not be decrypted; the user will need to sign in again`);
    }
  }
  return out;
}

/** How long after a member asks to sign an agent in its sandbox may save the result. */
export const SIGN_IN_WINDOW_MS = 30 * 60 * 1000;

export function signInRequestedRecently(requestedAt: string | null | undefined, now = Date.now()): boolean {
  if (!requestedAt) return false;
  const at = Date.parse(requestedAt);
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= SIGN_IN_WINDOW_MS;
}
