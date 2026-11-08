import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ComputerId, ThreadId } from "@lemonlime/protocol";
import { requirePageUser } from "@/lib/auth.ts";
import { computerThreadResponse } from "@/lib/computers.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError } from "@/lib/errors.ts";
import { bridgeControl } from "@/lib/phone-bridge.ts";
import { ThreadView } from "../../../threads/[id]/thread-view.tsx";

type Props = { params: Promise<{ computerId: string; threadId: string }> };

export const metadata: Metadata = { title: "Thread on your computer" };

/** A thread that runs on one of your own computers, through the phone bridge (docs/phone-access.md). */
export default async function ComputerThreadPage({ params }: Props) {
  const { computerId, threadId } = await params;
  if (!ComputerId.safeParse(computerId).success || !ThreadId.safeParse(threadId).success) notFound();
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, `/computers/${encodeURIComponent(computerId)}/${encodeURIComponent(threadId)}`);
  let data;
  try {
    data = await computerThreadResponse(ctx, bridgeControl(ctx), user.userId, computerId, threadId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const { computer, ...initial } = data;
  return <ThreadView initial={initial} computer={computer} />;
}
