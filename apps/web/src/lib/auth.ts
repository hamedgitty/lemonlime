import { headers } from "next/headers";
import { bearerToken, hashAccessToken, looksLikeAccessToken } from "./access-tokens.ts";
import { HttpError } from "./http.ts";
import { supabaseAdmin } from "./supabase/admin.ts";
import { createSupabaseServerClient } from "./supabase/server.ts";

export interface AuthedUser {
  userId: string;
  email: string | null;
  /** How the request authenticated. */
  via: "session" | "token";
}

/**
 * The user behind a request: `Authorization: Bearer <personal access token>`
 * (desktop app) or the Supabase session cookie (web dashboard).
 */
export async function getUser(request?: Request): Promise<AuthedUser | null> {
  const authorization = request ? request.headers.get("authorization") : (await headers()).get("authorization");
  const bearer = bearerToken(authorization);
  if (bearer) return looksLikeAccessToken(bearer) ? userFromAccessToken(bearer) : null;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null, via: "session" };
}

export async function requireUser(request?: Request): Promise<AuthedUser> {
  const user = await getUser(request);
  if (!user) throw new HttpError(401, "Sign in or send a personal access token.");
  return user;
}

async function userFromAccessToken(raw: string): Promise<AuthedUser | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("access_tokens")
    .select("id, user_id, last_used_at")
    .eq("token_hash", hashAccessToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Record use at most once a minute to keep writes down.
  const last = data.last_used_at ? Date.parse(data.last_used_at) : 0;
  if (Date.now() - last > 60_000) {
    void db.from("access_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(
      () => undefined,
      () => undefined,
    );
  }
  return { userId: data.user_id as string, email: null, via: "token" };
}

/** Workspaces the user belongs to, oldest first. Creates a personal one if there is none. */
export async function userWorkspaceIds(userId: string): Promise<string[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("workspace_members")
    .select("workspace_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (data.length) return data.map(r => r.workspace_id as string);

  // Normally the database trigger does this at sign-up; this covers users created before it existed.
  const { data: ws, error: wsError } = await db
    .from("workspaces")
    .insert({ name: "Personal", personal: true, created_by: userId })
    .select("id")
    .single();
  if (wsError) throw wsError;
  const { error: memberError } = await db
    .from("workspace_members")
    .insert({ workspace_id: ws.id, user_id: userId, role: "owner" });
  if (memberError) throw memberError;
  return [ws.id as string];
}

/** The workspace to act in: the requested one if the user is a member, else their first. */
export async function resolveWorkspace(userId: string, requested?: string | null): Promise<string> {
  const ids = await userWorkspaceIds(userId);
  if (requested) {
    if (!ids.includes(requested)) throw new HttpError(403, "You are not a member of that workspace.");
    return requested;
  }
  return ids[0]!;
}
