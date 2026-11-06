"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for client components (sign-in only; data goes through the API). */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set at build time.");
  return createBrowserClient(url, key);
}
