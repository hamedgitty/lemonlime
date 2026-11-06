import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError } from "@/lib/errors.ts";
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
  return threadResponse(ctx, row, user.userId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Thread ${id}` };
}

export default async function ThreadPage({ params }: Props) {
  const { id } = await params;
  const initial = await load(id);
  return <ThreadView initial={initial} />;
}
