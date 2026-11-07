import type { AgentKind } from "@lemonlime/protocol";
import { acpAdapter, opencodeAdapter } from "./acp.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import type { AgentAdapter } from "./types.ts";

export * from "./types.ts";
export { lineSplitter, MAX_LINE_BYTES } from "./lines.ts";
export { runLineProcess } from "./process.ts";
export { compareVersions, detectVersion, parseVersion, TESTED_AGENTS, versionNotice, type TestedAgent } from "./versions.ts";
export { commandGuardSettings, parseClaudeLine } from "./claude-code.ts";
export { parseCodexLine } from "./codex.ts";
export { AcpTranslator, answerAgentRequest, acpAdapter, needsApproval } from "./acp.ts";
export { APPROVAL_TOOL } from "./claude-code.ts";

const adapters: Record<AgentKind, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  acp: acpAdapter(),
};

export function adapterFor(kind: AgentKind): AgentAdapter {
  return adapters[kind];
}
