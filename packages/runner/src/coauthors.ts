import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Removing `Co-authored-by:` trailers from the commits an agent makes in a thread.
 *
 * Git is pointed at a hooks folder of the runner's own through GIT_CONFIG_PARAMETERS, which
 * reaches every git command the agent (and anything it runs) starts, and nothing else: the
 * repository's config and hooks are never changed, so the user's own checkout is untouched.
 * Each hook in that folder first runs the repository's own hook of the same name (from its
 * `core.hooksPath`, or the usual `hooks` folder), so a project's pre-commit checks still
 * run; `commit-msg` then takes the trailers out.
 */

/** The client-side hooks git runs, so a project's own ones keep working. */
const HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "post-rewrite",
  "pre-auto-gc",
  "push-to-checkout",
];

/** Finds the repository's own hooks folder, ignoring the override that points git here. */
const FIND_OWN = `own=$( (unset GIT_CONFIG_PARAMETERS; git config --path core.hooksPath) 2>/dev/null )
if [ -z "$own" ]; then own="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"; fi
here=$(cd "$(dirname "$0")" && pwd)
if [ -d "$own" ] && [ "$(cd "$own" && pwd)" = "$here" ]; then own=""; fi`;

export function hookScript(name: string): string {
  if (name === "commit-msg") {
    return `#!/bin/sh
# Added by LemonLime for this thread only: runs the repository's own commit-msg hook, then
# removes Co-authored-by trailers from the message.
${FIND_OWN}
if [ -n "$own" ] && [ -x "$own/commit-msg" ]; then "$own/commit-msg" "$@" || exit $?; fi
msg="$1"
[ -f "$msg" ] || exit 0
kept=$(grep -v -i '^[[:space:]]*co-authored-by:' "$msg")
printf '%s\\n' "$kept" > "$msg"
exit 0
`;
  }
  return `#!/bin/sh
# Added by LemonLime for this thread only: runs the repository's own ${name} hook.
${FIND_OWN}
if [ -n "$own" ] && [ -x "$own/${name}" ]; then exec "$own/${name}" "$@"; fi
exit 0
`;
}

/**
 * Write the hooks folder and return the environment that makes git use it. Any
 * GIT_CONFIG_PARAMETERS already set are kept.
 */
export function installCoauthorHooks(dir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  for (const name of HOOKS) {
    const file = join(dir, name);
    writeFileSync(file, hookScript(name), { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  return { GIT_CONFIG_PARAMETERS: gitConfigParameters({ "core.hooksPath": dir }, env.GIT_CONFIG_PARAMETERS) };
}

/** GIT_CONFIG_PARAMETERS (git's own format for `-c` settings) with these settings added. */
export function gitConfigParameters(settings: Record<string, string>, existing?: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // 'key=value': the form every git version reads (newer ones also take 'key'='value').
  const added = Object.entries(settings).map(([k, v]) => quote(`${k}=${v}`));
  return [existing?.trim(), ...added].filter(Boolean).join(" ");
}

/** Remove Co-authored-by trailers from a commit message (what the hook does, for the runner's own use and tests). */
export function stripCoauthorTrailers(message: string): string {
  return message
    .split("\n")
    .filter(line => !/^\s*co-authored-by:/i.test(line))
    .join("\n")
    .replace(/\n+$/, "\n");
}
