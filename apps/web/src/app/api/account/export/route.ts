import { exportAccount } from "@/lib/account.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

/** Download everything kept about this account as one JSON file. Signed-in browser only. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  if (user.via !== "session") throw new HttpError(403, "Download your data from the dashboard, signed in with your email.");
  await enforce(ctx.db, `export:${user.userId}`, { max: 5, windowSeconds: 3600 }, "data exports");
  const data = await exportAccount(ctx, user.userId);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="lemonlime-data-${day}.json"`,
      "cache-control": "no-store",
    },
  });
});
