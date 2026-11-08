import { z } from "zod";
import { AGENT_CAPABILITIES } from "./capabilities.ts";
import type { AgentKind } from "./thread.ts";

/**
 * Agents that can keep several of the user's own accounts on one computer, each signed in
 * in a config folder of its own (Claude Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME).
 * LemonLime only points the agent at a folder; the agent keeps its own sign-in there.
 */
export const ACCOUNT_AGENTS = ["claude-code", "codex"] as const satisfies readonly AgentKind[];
export type AccountAgent = (typeof ACCOUNT_AGENTS)[number];

export function hasAccounts(kind: string): kind is AccountAgent {
  return (ACCOUNT_AGENTS as readonly string[]).includes(kind);
}

/** The agent's usual sign-in on this computer (its own config folder). */
export const DEFAULT_ACCOUNT_ID = "default";

/** Account ids are folder names, so they stay short and plain. */
export const AccountId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "account id must be 1-40 chars of a-z, 0-9 or -");
export type AccountId = z.infer<typeof AccountId>;

/** What happens when an agent hits its plan's usage limit. */
export const OnLimit = z.enum(["wait", "switch", "ask"]);
export type OnLimit = z.infer<typeof OnLimit>;

export const ON_LIMIT_LABELS: Record<OnLimit, string> = {
  wait: "Wait until it resets",
  switch: "Switch to my next account",
  ask: "Ask me",
};

/** An account as events name it. */
export const AccountRef = z.object({ id: AccountId, label: z.string().max(80) });
export type AccountRef = z.infer<typeof AccountRef>;

/** One account in `lemonlime-runner accounts list`. Never holds a token. */
export const AgentAccount = z.object({
  id: AccountId,
  label: z.string().max(80),
  /** The agent's usual sign-in, which can't be removed. */
  builtIn: z.boolean(),
  /** New threads use it. */
  isDefault: z.boolean(),
  /** null: couldn't tell (the agent isn't installed, or didn't answer). */
  signedIn: z.boolean().nullable(),
  /** As the agent reports it, where it does. */
  email: z.string().max(200).optional(),
  plan: z.string().max(80).optional(),
});
export type AgentAccount = z.infer<typeof AgentAccount>;

export const AccountsList = z.object({
  onLimit: OnLimit,
  agents: z.object({ "claude-code": z.array(AgentAccount), codex: z.array(AgentAccount) }),
});
export type AccountsList = z.infer<typeof AccountsList>;

/** A model's size class in a list: its own `tier`, or else its place in the list. */
function tierIn(list: readonly { id: string; tier?: number; family?: string }[], model: string): number {
  const m = model.toLowerCase();
  // Exact id first, then a name that contains a listed id or family ("claude-opus-4-5" is "opus").
  let i = list.findIndex(x => x.id.toLowerCase() === m);
  if (i < 0) i = list.findIndex(x => m.includes(x.id.toLowerCase()) || (x.family ? m.includes(x.family) : false));
  if (i < 0) return -1;
  return list[i]!.tier ?? i;
}

/**
 * A model of the same tier on another agent: each model's `tier` where the list gives one,
 * else its place in the list (lists are best first). null keeps that agent's own default
 * (also when the thread used its agent's default, or the model isn't a listed one).
 */
export function matchingModel(
  from: AgentKind,
  model: string | null | undefined,
  to: AgentKind,
  lists: { from?: readonly { id: string; tier?: number; family?: string }[]; to?: readonly { id: string; tier?: number; older?: boolean }[] } = {},
): string | null {
  if (!model) return null;
  const fromList = lists.from ?? AGENT_CAPABILITIES[from].models;
  const toList = (lists.to ?? AGENT_CAPABILITIES[to].models).filter(x => !x.older);
  if (!toList.length) return null;
  const tier = tierIn(fromList, model);
  if (tier < 0) return null;
  const tiers = toList.map((x, i) => x.tier ?? i);
  const want = Math.min(tier, Math.max(...tiers));
  return toList[tiers.findIndex(t => t >= want)]!.id;
}
