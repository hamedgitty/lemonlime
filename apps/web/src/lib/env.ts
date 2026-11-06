/**
 * Server configuration, read lazily so that `next build` never needs real values.
 * Each getter throws a clear error at request time if its variable is missing.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example and docs/self-hosting.md.`);
  return value;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  /** Public base URL of this control plane; runners send heartbeats here. */
  publicUrl: () => required("LEMONLIME_PUBLIC_URL").replace(/\/+$/, ""),
  tokenSecret: () => required("LEMONLIME_TOKEN_SECRET"),
  cronSecret: () => required("LEMONLIME_CRON_SECRET"),
};
