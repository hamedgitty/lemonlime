import type { AgentKind } from "@lemonlime/protocol";
import type { AutomationInfo } from "./cloud.ts";

/** What the automation form holds while it is being filled in. */
export interface AutomationForm {
  name: string;
  schedule: string;
  /** The time zone the schedule is read in. An automation keeps its own when it is changed. */
  timezone: string;
  agent: AgentKind;
  /** The model and effort an automation already had; kept unless another agent is picked. */
  model?: string;
  reasoning?: string;
  repoUrl: string;
  baseBranch: string;
  prompt: string;
  checkScript: string;
  size: "small" | "large";
  /** The workspace secrets its runs get: null for all of them, or only the ones named. */
  secretNames: string[] | null;
}

/** This computer's time zone. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** A blank form for a new automation, in this computer's time zone. */
export function newAutomationForm(schedule: string, zone: string = localZone()): AutomationForm {
  return {
    name: "",
    schedule,
    timezone: zone,
    agent: "claude-code",
    repoUrl: "",
    baseBranch: "main",
    prompt: "",
    checkScript: "",
    size: "small",
    secretNames: null,
  };
}

/** The form for changing an automation: everything as it is now, its time zone included. */
export function automationForm(a: AutomationInfo, zone: string = localZone()): AutomationForm {
  return {
    name: a.name,
    schedule: a.schedule,
    timezone: a.timezone || zone,
    agent: a.agent.kind,
    ...(a.agent.model ? { model: a.agent.model } : {}),
    ...(a.agent.reasoning ? { reasoning: a.agent.reasoning } : {}),
    repoUrl: a.repo.url,
    baseBranch: a.repo.baseBranch,
    prompt: a.prompt,
    checkScript: a.checkScript ?? "",
    size: a.sandboxSize ?? "small",
    secretNames: a.secretNames ?? null,
  };
}

/**
 * What saving the form sends. `before` is the automation being changed. Which secrets the
 * runs get is sent only when a list was chosen, or when an automation that had a list goes
 * back to all of them; left alone, the field never reaches a control plane that doesn't know it.
 */
export function automationBody(f: AutomationForm, before?: Pick<AutomationInfo, "secretNames">) {
  const secrets: { secretNames?: string[] | null } = f.secretNames
    ? { secretNames: f.secretNames }
    : Array.isArray(before?.secretNames)
      ? { secretNames: null }
      : {};
  return {
    name: f.name.trim(),
    schedule: f.schedule.trim(),
    timezone: f.timezone,
    agent: { kind: f.agent, ...(f.model ? { model: f.model } : {}), ...(f.reasoning ? { reasoning: f.reasoning } : {}) } as AutomationInfo["agent"],
    repo: { url: f.repoUrl.trim(), baseBranch: f.baseBranch.trim() || "main" },
    sandboxSize: f.size,
    prompt: f.prompt.trim(),
    checkScript: f.checkScript.trim(),
    ...secrets,
  };
}

/** The form's list of secrets with one ticked or unticked, in the order the workspace lists them. */
export function pickSecret(chosen: readonly string[], name: string, on: boolean): string[] {
  return on ? (chosen.includes(name) ? [...chosen] : [...chosen, name]) : chosen.filter(n => n !== name);
}

/**
 * The secrets the form offers: the workspace's, then any the automation still names that
 * the workspace no longer has, so they can be unticked before the control plane refuses them.
 */
export function secretChoices(known: readonly string[], chosen: readonly string[] | null): { name: string; gone: boolean }[] {
  return [...known.map(name => ({ name, gone: false })), ...(chosen ?? []).filter(name => !known.includes(name)).map(name => ({ name, gone: true }))];
}

/**
 * Whether a list of secrets was sent to a control plane that took no notice of it: one that
 * knows the field always answers with it. Such runs still get every workspace secret.
 */
export function secretChoiceIgnored(sent: { secretNames?: string[] | null }, saved: Pick<AutomationInfo, "secretNames">): boolean {
  return Array.isArray(sent.secretNames) && !Array.isArray(saved.secretNames);
}

/** Said when the secrets chosen for an automation weren't taken up. */
export const SECRET_CHOICE_IGNORED = "Saved, but this control plane can't limit an automation's secrets yet. Its runs still get every workspace secret.";

/**
 * Whether this person may change an automation: edit it, pause or resume it, make its
 * webhook, or delete it. The control plane says no for someone else's automation seen by a
 * member who isn't a workspace owner; one that says nothing leaves it to its own checks.
 */
export function canManageAutomation(a: Pick<AutomationInfo, "canManage">): boolean {
  return a.canManage !== false;
}

/** The line under an automation that is off. Only the person who can turn it back on is told they paused it. */
export function pausedLine(a: Pick<AutomationInfo, "pausedReason" | "canManage">): string {
  if (a.pausedReason) return `Paused automatically. ${a.pausedReason}`;
  return canManageAutomation(a) ? "Paused by you." : "Paused.";
}
