import { and, eq, sql } from "drizzle-orm";
import {
  LINK_TICKET_SECONDS,
  PHONE_TICKET_SECONDS,
  Thread,
  deriveBridgeKey,
  signBridgeTicket,
  type ComputerPlatform,
  type ComputerUpdate,
  type LocalThreadSnapshot,
  type RunnerEndpoint,
} from "@lemonlime/protocol";
import { computers, type ComputerRow } from "@lemonlime/db";
import { findComputerForUser, listComputersForUser } from "./access.ts";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";
import { bridgeBaseUrl, type BridgeControl } from "./phone-bridge.ts";
import type { ThreadResponse } from "./threads.ts";

/**
 * Phone access to threads on the user's own computers (docs/phone-access.md). The desktop
 * app registers its computer and, while phone access is on, shares a list of its threads
 * and keeps a link open to the bridge. Only the computer's owner sees or reaches it.
 */

/** A computer that checked in this recently counts as online in lists. */
export const ONLINE_WITHIN_MS = 150_000;

export interface ComputerSummary {
  id: string;
  name: string;
  platform: ComputerPlatform;
  phoneAccess: boolean;
  /**
   * The computer only answers phones paired with it, and seals everything it sends them.
   * False for a desktop app from before pairing.
   */
  sealed: boolean;
  online: boolean;
  lastSeenAt: string | null;
}

export interface ComputerThreads {
  computer: ComputerSummary;
  threads: LocalThreadSnapshot[];
}

/** A local thread opened through the bridge: the usual thread response, plus its computer. */
export type BridgedThreadResponse = ThreadResponse & { computer: ComputerSummary };

function seenRecently(row: ComputerRow, nowMs: number): boolean {
  return row.phoneAccess && !!row.lastSeenAt && nowMs - Date.parse(row.lastSeenAt) < ONLINE_WITHIN_MS;
}

function summary(row: ComputerRow, online: boolean): ComputerSummary {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    phoneAccess: row.phoneAccess,
    sealed: row.sealed,
    online,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * Register or update the caller's computer (the desktop app, in a workspace the caller was
 * checked against). Turning phone access off forgets the shared threads, makes every ticket
 * handed out so far useless, and cuts the link and every phone on it at once.
 */
export async function saveComputer(
  ctx: AppContext,
  bridge: BridgeControl | null,
  userId: string,
  workspaceId: string,
  computerId: string,
  update: ComputerUpdate,
  nowMs: number = Date.now(),
): Promise<ComputerSummary & { bridgeAvailable: boolean }> {
  const existing = (await ctx.db.select().from(computers).where(eq(computers.id, computerId)).get()) ?? null;
  // Someone else's computer id is reported as not found, like threads in other workspaces.
  if (existing && existing.userId !== userId) throw new HttpError(404, "Computer not found.");
  const now = new Date(nowMs).toISOString();
  const on = update.phoneAccess;
  const values = {
    name: update.name,
    platform: update.platform,
    workspaceId,
    phoneAccess: on,
    // What the app said this time: an app that doesn't say so doesn't seal.
    sealed: update.sealed === true,
    threads: on ? (update.threads ?? existing?.threads ?? []) : [],
    lastSeenAt: on ? now : null,
  };
  let row: ComputerRow;
  if (!existing) {
    [row] = (await ctx.db
      .insert(computers)
      .values({ id: computerId, userId, ...values })
      .returning()) as [ComputerRow];
  } else {
    [row] = (await ctx.db
      .update(computers)
      .set({ ...values, ...(on ? {} : { epoch: sql`${computers.epoch} + 1` }) })
      .where(and(eq(computers.id, computerId), eq(computers.userId, userId)))
      .returning()) as [ComputerRow];
  }
  if (!on) await bridge?.kill(computerId).catch(err => console.error("[lemonlime] could not close phone sessions:", err));
  return { ...summary(row, on && seenRecently(row, nowMs)), bridgeAvailable: bridge !== null };
}

/** Forget the caller's computer (the desktop app signed out): it disappears and its phones are cut off. */
export async function forgetComputer(ctx: AppContext, bridge: BridgeControl | null, userId: string, computerId: string): Promise<void> {
  const deleted = await ctx.db
    .delete(computers)
    .where(and(eq(computers.id, computerId), eq(computers.userId, userId)))
    .returning({ id: computers.id });
  if (deleted.length) await bridge?.kill(computerId).catch(err => console.error("[lemonlime] could not close phone sessions:", err));
}

/** For the desktop app: where to open its link and the ticket to open it with. */
export async function linkTicket(
  ctx: AppContext,
  bridge: BridgeControl | null,
  userId: string,
  computerId: string,
  nowMs: number = Date.now(),
): Promise<{ url: string; ticket: string; expiresAt: string }> {
  const row = await findComputerForUser(ctx.db, userId, computerId);
  if (!row) throw new HttpError(404, "Computer not found.");
  if (!row.phoneAccess) throw new HttpError(409, "Phone access is off for this computer.");
  if (!bridge) throw new HttpError(503, "Phone access isn't set up on this server.");
  const exp = Math.floor(nowMs / 1000) + LINK_TICKET_SECONDS;
  const ticket = await signBridgeTicket({ kind: "link", computerId, userId, epoch: row.epoch, exp }, await deriveBridgeKey(ctx.config.tokenSecret()));
  await ctx.db
    .update(computers)
    .set({ lastSeenAt: new Date(nowMs).toISOString() })
    .where(eq(computers.id, computerId));
  return { url: `${bridgeBaseUrl(ctx.config.publicUrl())}/api/phone/link/${computerId}`, ticket, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The caller's computers in a workspace with phone access on, and the threads each shares. */
export async function listComputerThreads(ctx: AppContext, userId: string, workspaceId: string, nowMs: number = Date.now()): Promise<ComputerThreads[]> {
  const rows = await listComputersForUser(ctx.db, userId, workspaceId);
  return rows.filter(r => r.phoneAccess).map(r => ({ computer: summary(r, seenRecently(r, nowMs)), threads: r.threads }));
}

/** A shared thread as the dashboard's thread type. */
export function snapshotToThread(s: LocalThreadSnapshot): Thread {
  return Thread.parse({
    id: s.id,
    title: s.title,
    agent: { kind: s.agent.kind, ...(s.agent.model ? { model: s.agent.model } : {}) },
    repo: { url: s.repoName || "repository", baseBranch: "main" },
    branch: s.branch,
    mode: "local",
    status: s.status,
    latestSeq: s.latestSeq,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });
}

/**
 * One thread on one of the caller's computers, with a fresh endpoint (the bridge's address
 * and a phone ticket) while the computer is linked. 404 unless the computer is the caller's,
 * they are still in its workspace, phone access is on and the computer shares the thread.
 */
export async function computerThreadResponse(
  ctx: AppContext,
  bridge: BridgeControl | null,
  userId: string,
  computerId: string,
  threadId: string,
  nowMs: number = Date.now(),
): Promise<BridgedThreadResponse> {
  const row = await findComputerForUser(ctx.db, userId, computerId);
  const shared = row?.phoneAccess ? row.threads.find(t => t.id === threadId) : undefined;
  if (!row || !shared) throw new HttpError(404, "Thread not found.");
  const online = bridge ? await bridge.linked(computerId).catch(() => false) : false;
  let endpoint: RunnerEndpoint | null = null;
  if (online) {
    const exp = Math.floor(nowMs / 1000) + PHONE_TICKET_SECONDS;
    const token = await signBridgeTicket(
      { kind: "phone", computerId, threadId, userId, epoch: row.epoch, exp },
      await deriveBridgeKey(ctx.config.tokenSecret()),
    );
    endpoint = { url: `${bridgeBaseUrl(ctx.config.publicUrl())}/api/phone/ws/${computerId}/${threadId}`, token, expiresAt: new Date(exp * 1000).toISOString() };
  }
  return { thread: snapshotToThread(shared), endpoint, initialPrompt: null, pullRequestUrl: null, computer: summary(row, online) };
}
