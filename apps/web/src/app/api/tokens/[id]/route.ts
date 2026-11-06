import { requireUser } from "@/lib/auth.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { supabaseAdmin } from "@/lib/supabase/admin.ts";

export const dynamic = "force-dynamic";

/** Revoke one of the user's personal access tokens. */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const user = await requireUser(request);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Token not found.");
  const { data, error } = await supabaseAdmin()
    .from("access_tokens")
    .delete()
    .eq("id", id)
    .eq("user_id", user.userId)
    .select("id");
  if (error) throw error;
  if (!data.length) throw new HttpError(404, "Token not found.");
  return json({ deleted: id });
});
