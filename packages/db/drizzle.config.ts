import { defineConfig } from "drizzle-kit";

/**
 * `pnpm --filter @lemonlime/db generate` writes a new SQL migration to
 * `migrations/` (the folder `wrangler d1 migrations apply` reads) and refreshes
 * `src/migrations.ts`, which embeds the same SQL for local SQLite and tests.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
