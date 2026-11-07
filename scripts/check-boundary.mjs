#!/usr/bin/env node
// Keeps this public repository self-contained and free of secrets. Fails when:
//
//  1. code imports a package no package.json in this repo declares (so nothing can
//     quietly depend on code that isn't public);
//  2. a tracked file contains something shaped like a live secret;
//  3. a tracked file matches an extra pattern from LEMONLIME_BOUNDARY_DENYLIST (newline-
//     separated regular expressions) or from the file it names in
//     LEMONLIME_BOUNDARY_DENYLIST_FILE. Deployments keep their own names there, so the
//     list itself never has to live in this repo.
//
// Usage: node scripts/check-boundary.mjs        (run by `pnpm check` and CI)
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);

// Built-in patterns for secrets that must never be committed. Placeholders like
// "sk_test_..." in docs are fine; these only match real-looking values.
const SECRET_PATTERNS = [
  ["Stripe live key", /\b(sk|rk|pk)_live_[0-9A-Za-z]{16,}/],
  ["Stripe webhook secret", /\bwhsec_[0-9A-Za-z]{24,}/],
  ["Stripe price or product id", /\b(price|prod)_1[0-9A-Za-z]{14,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[0-9A-Za-z]{36,}\b/],
  ["Anthropic API key", /\bsk-ant-(api|admin)\d{2}-[0-9A-Za-z_-]{20,}/],
  ["OpenAI API key", /\bsk-(proj|svcacct)-[0-9A-Za-z_-]{20,}/],
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ["Slack token", /\bxox[abprs]-[0-9A-Za-z-]{20,}/],
];

function extraPatterns() {
  let text = process.env.LEMONLIME_BOUNDARY_DENYLIST ?? "";
  const file = process.env.LEMONLIME_BOUNDARY_DENYLIST_FILE;
  if (file) text += "\n" + readFileSync(file, "utf8");
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(l => ["denylisted text", new RegExp(l, "i")]);
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|pdf|zip|gz|wasm)$/i;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const problems = [];

// 1. Imports must be declared somewhere in this repo.
const declared = new Set();
for (const f of files.filter(f => f.endsWith("package.json"))) {
  const pkg = JSON.parse(readFileSync(join(root, f), "utf8"));
  if (pkg.name) declared.add(pkg.name);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) declared.add(name);
  }
}
const builtins = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'\s]+)["']/gm;
function packageOf(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~/")) return null;
  if (spec.startsWith("node:") || builtins.has(spec)) return null;
  if (/^(https?|data|virtual|bun):/.test(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const patterns = [...SECRET_PATTERNS, ...extraPatterns()];
for (const f of files) {
  if (BINARY.test(f)) continue;
  const path = join(root, f);
  let text;
  try {
    if (statSync(path).size > 2 * 1024 * 1024) continue;
    text = readFileSync(path, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  if (CODE.test(f)) {
    for (const m of text.matchAll(IMPORT)) {
      const pkg = packageOf(m[1]);
      if (pkg && !declared.has(pkg)) problems.push(`${f}: imports "${m[1]}", which no package.json in this repo declares`);
    }
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [what, re] of patterns) if (re.test(line)) problems.push(`${f}:${i + 1}: looks like a ${what}`);
  });
}

if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n` + problems.map(p => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Boundary check passed (${files.length} files).`);
