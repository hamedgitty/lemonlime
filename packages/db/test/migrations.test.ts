import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/migrations.ts";
import { createLocalDb, migrateClient } from "../src/local.ts";

const dir = join(import.meta.dirname, "..", "migrations");

describe("migrations", () => {
  it("embeds exactly the SQL files wrangler applies (run `pnpm --filter @lemonlime/db generate` after schema changes)", () => {
    const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
    expect(migrations.map(m => m.name)).toEqual(files);
    for (const m of migrations) expect(m.sql).toBe(readFileSync(join(dir, m.name), "utf8"));
  });

  it("applies once, recording each migration like wrangler does", async () => {
    const { client } = await createLocalDb(":memory:");
    expect(await migrateClient(client)).toEqual([]);
    const applied = await client.execute("SELECT name FROM d1_migrations ORDER BY id");
    expect(applied.rows.map(r => r.name)).toEqual(migrations.map(m => m.name));
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.rows.map(r => r.name)).toEqual(
      expect.arrayContaining(["user", "session", "account", "verification", "workspaces", "workspace_members", "threads", "sandbox_runs", "access_tokens"]),
    );
  });

  it("enforces foreign keys and checks", async () => {
    const { client } = await createLocalDb(":memory:");
    await expect(
      client.execute("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('nope', 'nobody', 'owner', '')"),
    ).rejects.toThrow(/FOREIGN KEY/);
    await client.execute("INSERT INTO user (id, name, email, updated_at) VALUES ('u1', '', 'u1@example.com', 0)");
    await client.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', '')");
    await expect(
      client.execute("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('w1', 'u1', 'admin', '')"),
    ).rejects.toThrow(/CHECK/);
  });
});
