import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Db } from "@lemonlime/db";
import { createAppContext, createWorkersContext, type AppContext } from "./context.ts";

/**
 * The current request's environment.
 *
 * - On Cloudflare Workers (OpenNext), `getCloudflareContext().env` holds vars,
 *   secrets and bindings: `DB` (D1) and optionally `EMAIL` (Email Service).
 * - On plain Node (`next dev`, `next start`), it is `process.env` plus a local
 *   SQLite database at `LEMONLIME_DATABASE_URL` (default `file:./data/lemonlime.db`),
 *   migrated on first use.
 *
 * Read lazily so `next build` never needs real values; settings that are missing
 * fail only the requests that need them, with a message naming the variable.
 */
export async function getAppContext(): Promise<AppContext> {
  const workersEnv = cloudflareEnv();
  if (workersEnv) {
    let ctx = workersContexts.get(workersEnv);
    if (!ctx) {
      ctx = createWorkersContext(workersEnv);
      workersContexts.set(workersEnv, ctx);
    }
    return ctx;
  }
  nodeContext ??= createNodeContext().catch(err => {
    nodeContext = null; // retry on the next request instead of caching the failure
    throw err;
  });
  return nodeContext;
}

const workersContexts = new WeakMap<object, AppContext>();
let nodeContext: Promise<AppContext> | null = null;

function cloudflareEnv(): Record<string, unknown> | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown> | undefined;
    return env && typeof env === "object" && "DB" in env ? env : null;
  } catch {
    return null; // not running on Workers
  }
}

/** Default SQLite location for Node deployments, relative to the app's working directory. */
export const DEFAULT_DATABASE_URL = "file:./data/lemonlime.db";

async function createNodeContext(): Promise<AppContext> {
  const url = process.env.LEMONLIME_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
  const db = await openLocalDb(url);
  return createAppContext({
    runtime: "node",
    env: process.env as Record<string, unknown>,
    db,
    production: process.env.NODE_ENV === "production",
  });
}

async function openLocalDb(url: string): Promise<Db> {
  if (url.startsWith("file:")) {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = url.slice("file:".length);
    if (path && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  }
  const { createLocalDb } = await import("@lemonlime/db/local");
  return (await createLocalDb(url)).db;
}
