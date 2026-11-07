import { createD1Db, type D1Binding, type Db } from "@lemonlime/db";
import { resolvePlugin, type ResolvedPlugin } from "@lemonlime/plugins";
import { createSandboxProvider, type SandboxProvider } from "@lemonlime/sandbox";
import pluginExport from "@lemonlime/deployment-plugin";
import { createEmailSender, type EmailSender, type SendEmailBinding } from "./email.ts";

/**
 * Everything a request (or the scheduled sweep) needs, built from the platform's
 * environment. On Cloudflare Workers that is the Worker `env` (vars, secrets and
 * bindings); on Node it is `process.env` plus a local SQLite database.
 *
 * Library code takes an `AppContext` explicitly instead of reading globals, so the
 * same code runs in route handlers, in the Worker's `scheduled()` handler and in tests.
 */
export interface AppContext {
  runtime: "workers" | "node";
  /** String settings: vars and secrets. */
  vars: Record<string, string | undefined>;
  /** The whole environment, bindings included. Plugins see this. */
  env: Record<string, unknown>;
  db: Db;
  production: boolean;
  plugin: ResolvedPlugin;
  email: EmailSender;
  /** The configured sandbox provider, created on first use. */
  sandbox(): SandboxProvider;
  config: AppConfig;
}

export interface AppConfig {
  /** Public base URL of this control plane; runners send heartbeats here. */
  publicUrl(): string;
  runnerControlPlaneUrl(): string;
  /** Master secret for runner and client tokens. */
  tokenSecret(): string;
  /** Bearer secret for /api/cron/sweep. */
  cronSecret(): string;
}

/** Only the string values of an environment (Workers mixes vars and bindings in one object). */
export function stringVars(env: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

export function makeConfig(vars: Record<string, string | undefined>): AppConfig {
  const required = (name: string): string => {
    const value = vars[name];
    if (!value) throw new Error(`${name} is not set. See .env.example and docs/self-hosting.md.`);
    return value;
  };
  return {
    publicUrl: () => required("LEMONLIME_PUBLIC_URL").replace(/\/+$/, ""),
    // Where runners send heartbeats. Defaults to the public URL; set it when sandboxes
    // reach the control plane on an internal address (e.g. http://web:3000 in docker compose).
    runnerControlPlaneUrl: () => (vars.LEMONLIME_RUNNER_CONTROL_PLANE_URL || required("LEMONLIME_PUBLIC_URL")).replace(/\/+$/, ""),
    tokenSecret: () => required("LEMONLIME_TOKEN_SECRET"),
    cronSecret: () => required("LEMONLIME_CRON_SECRET"),
  };
}

export interface CreateAppContextOptions {
  runtime: AppContext["runtime"];
  env: Record<string, unknown>;
  db: Db;
  production?: boolean;
  /** Overrides for tests. */
  plugin?: ResolvedPlugin;
  sandbox?: () => SandboxProvider;
  email?: EmailSender;
}

export function createAppContext(opts: CreateAppContextOptions): AppContext {
  const vars = stringVars(opts.env);
  const production = opts.production ?? vars.NODE_ENV === "production";
  const binding = isSendEmailBinding(opts.env.EMAIL) ? opts.env.EMAIL : null;
  let provider: SandboxProvider | null = null;
  return {
    runtime: opts.runtime,
    vars,
    env: opts.env,
    db: opts.db,
    production,
    plugin: opts.plugin ?? resolvePlugin(pluginExport, { env: opts.env }),
    email: opts.email ?? createEmailSender({ vars, binding, production }),
    sandbox:
      opts.sandbox ??
      (() => {
        provider ??= createSandboxProvider(vars);
        return provider;
      }),
    config: makeConfig(vars),
  };
}

/** Context for a Cloudflare Worker: `env.DB` is the D1 database. */
export function createWorkersContext(env: Record<string, unknown>): AppContext {
  const binding = env.DB as D1Binding | undefined;
  if (!binding) throw new Error("The Worker has no D1 binding named DB. See apps/web/wrangler.jsonc.");
  // Treated as production unless NODE_ENV=development is set (e.g. in .dev.vars for `wrangler dev`).
  const production = env.NODE_ENV !== "development";
  return createAppContext({ runtime: "workers", env, db: createD1Db(binding), production });
}

function isSendEmailBinding(value: unknown): value is SendEmailBinding {
  return typeof value === "object" && value !== null && typeof (value as SendEmailBinding).send === "function";
}
