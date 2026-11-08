import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { z } from "zod";
import { json, parseBody, route } from "@/lib/http.ts";
import { deleteThread, getThreadRowForUser, renameThread, threadResponse } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The thread, plus a fresh runner endpoint and client token while its sandbox runs. */
export const GET = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const row = await getThreadRowForUser(ctx, user.userId, (await params).id);
  return json(await threadResponse(ctx, row, user.userId));
});

const RenameBody = z.object({ title: z.string().min(1).max(200) });

/** Rename the thread. */
export const PATCH = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const body = await parseBody(request, RenameBody);
  return json(await renameThread(ctx, user.userId, (await params).id, body.title));
});

/** Close the thread and destroy its sandbox. */
export const DELETE = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json(await deleteThread(ctx, user.userId, (await params).id));
});
