import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { Db } from "./index.ts";
import { migrations as allMigrations, type Migration } from "./migrations.ts";
import * as schema from "./schema.ts";

/**
 * Same bookkeeping table `wrangler d1 migrations apply` uses, so a database
 * migrated by either tool is understood by the other.
 */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Apply every migration that has not run yet. Returns the names it applied. */
export async function migrateClient(client: Client, migrations: readonly Migration[] = allMigrations): Promise<string[]> {
  await client.execute(MIGRATIONS_TABLE);
  const done = new Set((await client.execute("SELECT name FROM d1_migrations")).rows.map(r => String(r.name)));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    await client.executeMultiple(m.sql);
    await client.execute({ sql: "INSERT INTO d1_migrations (name) VALUES (?)", args: [m.name] });
    applied.push(m.name);
  }
  return applied;
}

export interface LocalDb {
  db: Db;
  client: Client;
}

/**
 * Drizzle over libSQL, for running on plain Node and in tests.
 * `url` is e.g. `file:./data/lemonlime.db` or `:memory:`. Migrations are applied
 * on open unless `migrate: false`.
 */
export async function createLocalDb(url: string, opts: { migrate?: boolean } = {}): Promise<LocalDb> {
  const client = createClient({ url: url === ":memory:" ? ":memory:" : url });
  // D1 always enforces foreign keys; match it.
  await client.execute("PRAGMA foreign_keys = ON");
  if (opts.migrate !== false) await migrateClient(client);
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, client };
}
