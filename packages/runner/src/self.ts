import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The runner's script entry point, when running from source (bin/lemonlime-runner.js). */
export const RUNNER_SCRIPT = fileURLToPath(new URL("../bin/lemonlime-runner.js", import.meta.url));

/** True when this is the single-file runner the desktop app ships (a Node SEA build). */
export function isSingleExecutable(): boolean {
  try {
    return (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

/**
 * The command that runs one of the runner's own subcommands (git-credential,
 * approval-mcp): the executable itself when shipped as one file, else Node plus the script.
 */
export function selfCommand(subcommand: string): string[] {
  return isSingleExecutable() ? [process.execPath, subcommand] : [process.execPath, RUNNER_SCRIPT, subcommand];
}
