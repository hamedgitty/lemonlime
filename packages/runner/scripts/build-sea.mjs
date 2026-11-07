#!/usr/bin/env node
// Build the runner as one executable (a Node "single executable application") for the
// desktop app to ship as a sidecar, so nobody has to install Node or the runner.
//
//   pnpm --filter @lemonlime/runner build:sea [target-triple]
//
// Writes apps/desktop/src-tauri/binaries/lemonlime-runner-<target-triple>[.exe]. The
// target defaults to this machine's (from `rustc -vV`). Build on each platform you ship;
// a Node SEA can't be cross-built.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const work = join(pkg, "dist", "sea");
const target = process.argv[2] || /host: (\S+)/.exec(execFileSync("rustc", ["-vV"]).toString())?.[1];
if (!target) throw new Error("Pass the target triple, e.g. aarch64-apple-darwin");
const exe = target.includes("windows") ? ".exe" : "";
const outDir = join(pkg, "..", "..", "apps", "desktop", "src-tauri", "binaries");
const out = join(outDir, `lemonlime-runner-${target}${exe}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 1. One CommonJS file with every dependency inside.
await build({
  entryPoints: [join(pkg, "src", "sea-entry.ts")],
  outfile: join(work, "runner.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // import.meta.url has no meaning in a CommonJS bundle; paths that need it are passed in
  // through the environment by the desktop app (skills folder) or come from execPath.
  define: { "import.meta.url": "__lemonlimeUrl" },
  banner: { js: 'const __lemonlimeUrl = require("node:url").pathToFileURL(__filename).href;' },
  legalComments: "none",
  logLevel: "warning",
});

// 2. The SEA blob, then 3. a copy of Node with the blob injected.
writeFileSync(
  join(work, "sea-config.json"),
  JSON.stringify({ main: join(work, "runner.cjs"), output: join(work, "sea.blob"), disableExperimentalSEAWarning: true }),
);
execFileSync(process.execPath, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });
copyFileSync(process.execPath, out);
const mac = process.platform === "darwin";
if (mac) execFileSync("codesign", ["--remove-signature", out]);
const postject = join(pkg, "node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
execFileSync(
  postject,
  [
    out,
    "NODE_SEA_BLOB",
    join(work, "sea.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(mac ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit" },
);
// The release signs the whole app; locally an ad-hoc signature is enough to run it.
if (mac) execFileSync("codesign", ["--sign", "-", out]);
console.log(`Built ${out}`);
