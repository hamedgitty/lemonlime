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
}

/** This computer's time zone. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** A blank form for a new automation, in this computer's time zone. */
export function newAutomationForm(schedule: string, zone: string = localZone()): AutomationForm {
  return { name: "", schedule, timezone: zone, agent: "claude-code", repoUrl: "", baseBranch: "main", prompt: "", checkScript: "", size: "small" };
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
  };
}

/** What saving the form sends. */
export function automationBody(f: AutomationForm) {
  return {
    name: f.name.trim(),
    schedule: f.schedule.trim(),
    timezone: f.timezone,
    agent: { kind: f.agent, ...(f.model ? { model: f.model } : {}), ...(f.reasoning ? { reasoning: f.reasoning } : {}) } as AutomationInfo["agent"],
    repo: { url: f.repoUrl.trim(), baseBranch: f.baseBranch.trim() || "main" },
    sandboxSize: f.size,
    prompt: f.prompt.trim(),
    checkScript: f.checkScript.trim(),
  };
}
