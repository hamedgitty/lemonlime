import { execFile } from "node:child_process";
import type { AgentKind } from "@lemonlime/protocol";

/**
 * The agent CLI versions LemonLime is tested with. The recorded runs in
 * test/fixtures/agents were made with exactly these, and the sandbox image installs
 * exactly these. Change a version only together with a fresh recording
 * (`pnpm --filter @lemonlime/runner record <agent>`) and a passing `pnpm test`.
 */
export const TESTED_AGENTS = {
  "claude-code": { binary: "claude", npm: "@anthropic-ai/claude-code", version: "2.1.302", update: "claude update" },
  codex: { binary: "codex", npm: "@openai/codex", version: "0.167.0", update: "codex update" },
  opencode: { binary: "opencode", npm: "opencode-ai", version: "1.18.18", update: "opencode upgrade" },
} as const satisfies Partial<Record<AgentKind, { binary: string; npm: string; version: string; update: string }>>;

export type TestedAgent = keyof typeof TESTED_AGENTS;

/** First x.y.z in a `--version` line, e.g. "codex-cli 0.167.0" → "0.167.0". */
export function parseVersion(text: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0] ?? null;
}

/** Negative if a < b, 0 if equal, positive if a > b. Compares x.y.z numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Ask a CLI for its version. Resolves null if it can't be run or doesn't say. */
export function detectVersion(binary: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise(resolve => {
    execFile(binary, ["--version"], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? null : parseVersion(`${stdout}\n${stderr}`));
    });
  });
}

/**
 * A note for the user when their CLI is older than the tested one, or null when it's
 * the tested version or newer (newer is usually fine; the recorded runs catch breaks).
 */
export function versionNotice(kind: AgentKind, installed: string | null): string | null {
  const tested = (TESTED_AGENTS as Partial<Record<AgentKind, (typeof TESTED_AGENTS)[TestedAgent]>>)[kind];
  if (!tested || !installed || compareVersions(installed, tested.version) >= 0) return null;
  return `${tested.binary} ${installed} is older than the version LemonLime is tested with (${tested.version}). If the agent misbehaves, update it by running \`${tested.update}\`.`;
}
