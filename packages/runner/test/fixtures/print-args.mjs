// Stands in for an agent CLI: writes the arguments, stdin and git settings it was started
// with to $ARGS_OUT, then exits successfully without printing anything.
import { readFileSync, writeFileSync } from "node:fs";

let stdin = null;
try {
  stdin = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
writeFileSync(process.env.ARGS_OUT, JSON.stringify({ args: process.argv.slice(2), stdin, gitConfig: process.env.GIT_CONFIG_PARAMETERS ?? null }));
