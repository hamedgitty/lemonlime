import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth.ts";
import { HttpError } from "@/lib/http.ts";
import { getThreadRowForUser, threadResponse, type ThreadRow } from "@/lib/threads.ts";
import { ThreadView } from "./thread-view.tsx";

type Props = { params: Promise<{ id: string }> };

async function load(id: string) {
  const user = await requireUser();
  let row: ThreadRow;
  try {
    row = await getThreadRowForUser(user.userId, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  return threadResponse(row, user.userId);
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
