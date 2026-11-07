import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../check-boundary.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "boundary-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const run = (cwd: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
const pkg = JSON.stringify({ name: "@demo/app", dependencies: { zod: "^4" } });

describe("check-boundary", () => {
  it("passes a self-contained repo", () => {
    const dir = repo({ "package.json": pkg, "src/a.ts": 'import { z } from "zod";\nimport { join } from "node:path";\nimport x from "./x.ts";\n' });
    expect(run(dir).status).toBe(0);
  });

  it("fails on an import no package.json declares", () => {
    const dir = repo({ "package.json": pkg, "src/a.ts": 'import { plan } from "@somewhere-else/plans";\n' });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('imports "@somewhere-else/plans"');
  });

  it("fails on secret-shaped text but not on placeholders", () => {
    const fake = "sk_" + "live_" + "a1B2c3D4e5F6g7H8i9J0";
    expect(run(repo({ "package.json": pkg, "notes.txt": `key=${fake}\n` })).stderr).toContain("Stripe live key");
    expect(run(repo({ "package.json": pkg, ".env.example": "STRIPE_SECRET_KEY=sk_test_replace_me\n" })).status).toBe(0);
  });

  it("applies an extra denylist kept outside the repo", () => {
    const dir = repo({ "package.json": pkg, "docs/a.md": "Talk to internal-billing-host for help\n" });
    expect(run(dir).status).toBe(0);
    const r = run(dir, { LEMONLIME_BOUNDARY_DENYLIST: "# private names\ninternal-billing-host" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/a.md:1: looks like a denylisted text");
  });
});
