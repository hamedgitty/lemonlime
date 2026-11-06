import { z } from "zod";
import { generateAccessToken, hashAccessToken } from "@/lib/access-tokens.ts";
import { requireUser } from "@/lib/auth.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { supabaseAdmin } from "@/lib/supabase/admin.ts";

export const dynamic = "force-dynamic";

const CreateAccessTokenRequest = z.object({ name: z.string().trim().min(1).max(100) });

interface AccessTokenRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

const toJson = (r: AccessTokenRow) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at });

/** Personal access tokens of the signed-in user (never their values). */
export const GET = route(async request => {
  const user = await requireUser(request);
  const { data, error } = await supabaseAdmin()
    .from("access_tokens")
    .select("id, name, created_at, last_used_at")
    .eq("user_id", user.userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return json({ tokens: (data as AccessTokenRow[]).map(toJson) });
});

/** Create a token. The raw value is in this response only; just its SHA-256 is stored. */
export const POST = route(async request => {
  const user = await requireUser(request);
  // A leaked token must not be able to mint more tokens.
  if (user.via !== "session") throw new HttpError(403, "Create tokens from the web dashboard.");
  const { name } = await parseBody(request, CreateAccessTokenRequest);
  const raw = generateAccessToken();
  const { data, error } = await supabaseAdmin()
    .from("access_tokens")
    .insert({ user_id: user.userId, name, token_hash: hashAccessToken(raw) })
    .select("id, name, created_at, last_used_at")
    .single();
  if (error) throw error;
  return json({ token: raw, accessToken: toJson(data as AccessTokenRow) }, 201);
});
