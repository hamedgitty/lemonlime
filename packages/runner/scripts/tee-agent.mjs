#!/usr/bin/env node
// tee-agent.mjs <logfile> <cmd> [args...]
// Runs an agent CLI with stdio passed through, logging every line with its direction,
// so `record-fixture.ts` can turn a real run into a test fixture.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [log, cmd, ...args] = process.argv.slice(2);
const w = (dir, line) => appendFileSync(log, JSON.stringify({ dir, line }) + "\n");
w("argv", JSON.stringify([cmd, ...args]));
// When recording from inside another Claude Code session, its variables would stop the
// nested CLI from using your normal sign-in. CLAUDE_CONFIG_DIR is kept on purpose.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "CLAUDE_CONFIG_DIR" || !/^(CLAUDE|ANTHROPIC_)/.test(k)));
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env });
createInterface({ input: process.stdin }).on("line", l => {
  w("in", l);
  child.stdin.write(l + "\n");
});
process.stdin.on("end", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", l => {
  w("out", l);
  process.stdout.write(l + "\n");
});
child.stderr.on("data", d => process.stderr.write(d));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("close", (code, sig) => {
  w("exit", JSON.stringify({ code, sig }));
  process.exit(code ?? 1);
});
