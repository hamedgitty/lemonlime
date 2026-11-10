import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError } from "@/lib/errors.ts";
import { listMembers } from "@/lib/members.ts";
import { getThreadRowForUser, threadResponse, type ThreadRow } from "@/lib/threads.ts";
import { ThreadView } from "./thread-view.tsx";

type Props = { params: Promise<{ id: string }> };

async function load(id: string) {
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, `/threads/${encodeURIComponent(id)}`);
  let row: ThreadRow;
  try {
    row = await getThreadRowForUser(ctx, user.userId, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const { members } = await listMembers(ctx.db, row.workspaceId);
  const startedBy = members.find(m => m.userId === row.createdBy);
  return {
    initial: await threadResponse(ctx, row, user.userId),
    // A sign-in is saved to the account of the person who started the thread, so only they are offered it.
    canSignIn: row.createdBy === user.userId,
    // Shown to members who can read the thread but not direct it. Null once that person has left the workspace.
    starter: startedBy ? startedBy.name || startedBy.email || "Someone in this workspace" : null,
    hasOtherMembers: members.length > 1,
    // Closing is for the person who started the thread and for the workspace's owners.
    canClose: row.createdBy === user.userId || members.some(m => m.userId === user.userId && m.role === "owner"),
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Thread ${id}` };
}

export default async function ThreadPage({ params }: Props) {
  const { id } = await params;
  const { initial, ...viewer } = await load(id);
  return <ThreadView initial={initial} {...viewer} />;
}
