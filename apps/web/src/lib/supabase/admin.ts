import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.ts";

let admin: SupabaseClient | null = null;

/**
 * Service-role client. Bypasses row-level security, so every caller must check
 * workspace membership itself (see `auth.ts` and `threads.ts`). Server only.
 */
export function supabaseAdmin(): SupabaseClient {
  admin ??= createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return admin;
}
