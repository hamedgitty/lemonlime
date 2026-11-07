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
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
  // A native module can't live inside the executable; it's shipped next to it (below).
  external: ["@lydell/node-pty"],
});

// The terminal's PTY: node-pty and its prebuilt binary for this target, in a folder the
// app ships as a resource and points the runner at (LEMONLIME_NODE_PTY_DIR).
const PTY_PLATFORMS = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
  "aarch64-pc-windows-msvc": "win32-arm64",
};
const ptyOut = join(outDir, "node-pty");
rmSync(ptyOut, { recursive: true, force: true });
mkdirSync(join(ptyOut, "node_modules", "@lydell"), { recursive: true });
writeFileSync(join(ptyOut, "README.md"), "node-pty for the thread terminal, copied here by packages/runner/scripts/build-sea.mjs.\n");
const requireHere = createRequire(join(pkg, "package.json"));
const ptyName = `node-pty-${PTY_PLATFORMS[target] ?? "unknown"}`;
try {
  const ptyDir = dirname(requireHere.resolve("@lydell/node-pty/package.json"));
  const platformDir = dirname(createRequire(join(ptyDir, "package.json")).resolve(`@lydell/${ptyName}/package.json`));
  cpSync(ptyDir, join(ptyOut, "node_modules", "@lydell", "node-pty"), { recursive: true, dereference: true });
  cpSync(platformDir, join(ptyOut, "node_modules", "@lydell", ptyName), { recursive: true, dereference: true });
} catch (err) {
  console.warn(`No prebuilt PTY for ${target} (${err instanceof Error ? err.message : err}); the terminal won't be available in this build.`);
}

// 2. The SEA blob, then 3. a copy of Node with the blob injected.
writeFileSync(
  join(work, "sea-config.json"),
  JSON.stringify({ main: join(work, "runner.cjs"), output: join(work, "sea.blob"), disableExperimentalSEAWarning: true }),
);
execFileSync(process.execPath, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });
copyFileSync(process.execPath, out);
const mac = process.platform === "darwin";
if (mac) execFileSync("codesign", ["--remove-signature", out]);
// Run postject's script with node itself: Windows won't start the .bin/postject.cmd shim
// without a shell (EINVAL), and this works the same everywhere.
const postject = join(pkg, "node_modules", "postject", "dist", "cli.js");
execFileSync(
  process.execPath,
  [
    postject,
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
