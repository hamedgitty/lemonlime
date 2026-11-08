import { z } from "zod";

/**
 * What the composer can offer as you type, served over HTTP by the thread's runner
 * (client token, `Authorization: Bearer`):
 *
 * - `GET /commands`: the slash commands the agent understands. Some come from the agent
 *   itself (Claude Code's init message, ACP's `available_commands_update`), the rest from
 *   command files and skills in the thread's working directory.
 * - `GET /files?q=<query>&limit=<n>`: files in the thread's working directory (tracked by
 *   git, plus new ones that aren't ignored), best fuzzy matches first.
 */

export const AgentCommandSource = z.enum(["agent", "project", "user", "skill", "plugin"]);
export type AgentCommandSource = z.infer<typeof AgentCommandSource>;

export const AgentCommand = z.object({
  /** Without the slash, e.g. "review" or "frontend:component". */
  name: z.string().min(1).max(200),
  description: z.string().max(1000).default(""),
  /** A hint for what to type after it, e.g. "<file>". */
  hint: z.string().max(200).optional(),
  source: AgentCommandSource.default("agent"),
});
export type AgentCommand = z.infer<typeof AgentCommand>;

export const CommandsResponse = z.object({ commands: z.array(AgentCommand) });
export type CommandsResponse = z.infer<typeof CommandsResponse>;

export const FilesResponse = z.object({
  files: z.array(z.string()),
  /** How many files the working directory has in all (up to the runner's cap). */
  total: z.number().int().nonnegative(),
  /** More files matched than were sent. */
  truncated: z.boolean(),
});
export type FilesResponse = z.infer<typeof FilesResponse>;

/** The most files the runner lists in one answer. */
export const FILES_LIMIT_MAX = 200;
