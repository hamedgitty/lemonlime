import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };
export { migrations, type Migration } from "./migrations.ts";

/**
 * A LemonLime database: Drizzle over Cloudflare D1 (`createD1Db`) or over a
 * local SQLite file / in-memory database (`createLocalDb` from `@lemonlime/db/local`).
 * Both are async SQLite, so app code is written once against this type.
 */
export type Db = BaseSQLiteDatabase<"async", unknown, typeof schema>;

/** The `d1_databases` binding a Worker receives (e.g. `env.DB`). */
export type D1Binding = AnyD1Database;

/** Drizzle over a Cloudflare D1 binding. Cheap: call it per request. */
export function createD1Db(binding: D1Binding): Db {
  return drizzle(binding, { schema }) as unknown as Db;
}
