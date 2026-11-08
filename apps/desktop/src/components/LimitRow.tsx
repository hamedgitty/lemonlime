import { useEffect, useState } from "react";
import { ArrowRightLeft, ChevronDown, Clock, Gauge, UserRound } from "lucide-react";
import { AGENT_CAPABILITIES, hasAccounts, type AgentKind, type EventOf } from "@lemonlime/protocol";
import type { LimitChoices } from "../lib/accounts.ts";
import { AGENT_LABELS } from "../lib/format.ts";
import { Menu, MenuItem } from "./primitives.tsx";
import { Button, Spinner } from "./ui.tsx";

/** What a limit row can do, from the thread view (absent while it can't act). */
export interface LimitActions {
  choices: (hit: EventOf<"limit_hit">) => LimitChoices;
  /** This thread can switch accounts (local threads). */
  canSwitchAccount: boolean;
  switchAccount: (accountId: string) => void;
  switchAgent: (agent: AgentKind, model: string | null) => void;
  wait: () => void;
  /** Other threads stopped on the limit this thread just switched away from. */
  others: { count: number; switchThem: () => Promise<void> } | null;
}

/** "3:00 PM" today, else "Mon 10 Nov, 3:00 PM". */
export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

function modelLabel(kind: AgentKind, model: string | null): string | null {
  if (!model) return null;
  return AGENT_CAPABILITIES[kind].models.find(m => m.id === model)?.label ?? model;
}

export function LimitRow({
  hit,
  open,
  waiting,
  actions,
}: {
  hit: EventOf<"limit_hit">;
  open: boolean;
  waiting: { until: string | null } | null;
  actions?: LimitActions | undefined;
}) {
  const [sent, setSent] = useState<string | null>(null);
  // If nothing came of it (the runner said no), the buttons come back.
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), 10_000);
    return () => clearTimeout(t);
  }, [sent]);
  const agent = AGENT_LABELS[hit.agent];
  const who = hit.account ? ` on ${hit.account.label}` : "";
  const resets = hit.resetAt ? `It resets at ${whenText(hit.resetAt)}.` : "It didn't say when it resets.";

  if (!open) {
    return (
      <div className="flex items-start gap-2.5 px-1 text-[13.5px] text-ink-soft" role="note">
        <Gauge aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
        <p className="min-w-0 [overflow-wrap:anywhere]">
          {agent} hit its usage limit{who}. {resets}
        </p>
      </div>
    );
  }

  const choices = actions ? actions.choices(hit) : { accounts: [], agents: [] };
  const act = (key: string, fn: () => void) => {
    setSent(key);
    fn();
  };
  const disabled = !actions || sent !== null;
  const canSwitch = Boolean(actions?.canSwitchAccount && hasAccounts(hit.agent));
  return (
    <div className="animate-rise rounded-2xl border border-[#f0d95c] bg-lemon-soft/70 px-4 py-3.5" role="group" aria-label={`${agent} hit its usage limit`}>
      <p className="font-medium text-ink">
        {agent} hit its usage limit{who}
      </p>
      <p className="mt-1 text-[13.5px] text-ink-soft">
        {resets}{" "}
        {waiting ? (
          <span className="inline-flex items-center gap-1">
            <Clock aria-hidden="true" className="size-3.5" />
            {waiting.until ? `LemonLime will try again at ${whenText(waiting.until)}.` : "LemonLime will try again later."}
          </span>
        ) : (
          "Pick how to carry on."
        )}
      </p>
      {hit.message && <p className="mt-1.5 text-[13px] text-ink-faint [overflow-wrap:anywhere]">“{hit.message.trim().slice(0, 300)}”</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canSwitch && (
          <Menu
            trigger={
              <Button variant="primary" size="sm" disabled={disabled || choices.accounts.length === 0}>
                {sent === "account" ? <Spinner /> : <UserRound aria-hidden="true" className="size-3.5" />}
                Switch account
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </Button>
            }
          >
            {choices.accounts.map(a => (
              <MenuItem key={a.id} hint={a.email} onSelect={() => act("account", () => actions?.switchAccount(a.id))}>
                {a.label}
              </MenuItem>
            ))}
          </Menu>
        )}
        <Menu
          trigger={
            <Button variant={canSwitch && choices.accounts.length ? "secondary" : "primary"} size="sm" disabled={disabled || choices.agents.length === 0}>
              {sent === "agent" ? <Spinner /> : <ArrowRightLeft aria-hidden="true" className="size-3.5" />}
              Continue on another agent
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {choices.agents.map(a => (
            <MenuItem key={a.kind} hint={modelLabel(a.kind, a.model)} onSelect={() => act("agent", () => actions?.switchAgent(a.kind, a.model))}>
              {AGENT_LABELS[a.kind]}
            </MenuItem>
          ))}
        </Menu>
        {!waiting && (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={() => act("wait", () => actions?.wait())}>
            {sent === "wait" ? <Spinner /> : <Clock aria-hidden="true" className="size-3.5" />}
            Try again at reset
          </Button>
        )}
      </div>
      {canSwitch && choices.accounts.length === 0 && (
        <p className="mt-2 text-[13px] text-ink-soft">To switch accounts, add another {agent} account in Settings, under Agents.</p>
      )}
    </div>
  );
}

export function SwitchRow({ event, others }: { event: EventOf<"agent_switch">; others?: LimitActions["others"] | undefined }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { from, to } = event;
  const sameAgent = from.agent === to.agent;
  const model = modelLabel(to.agent, to.model ?? null);
  const text = sameAgent
    ? `${event.auto ? "Switched by itself" : "Switched"} to ${to.account ? `your ${to.account.label} account` : "another account"}${event.carried === "session" ? ", in the same conversation." : ", with a summary of the thread so far."}`
    : `Carried on with ${AGENT_LABELS[to.agent]}${model ? ` (${model})` : ""}, starting from a summary of what ${AGENT_LABELS[from.agent]} did.`;
  return (
    <div className="flex flex-col gap-2 px-1 text-[13.5px] text-ink-soft" role="note">
      <div className="flex items-start gap-2.5">
        <ArrowRightLeft aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-leaf" />
        <p className="min-w-0 [overflow-wrap:anywhere]">{text}</p>
      </div>
      {others && others.count > 0 && !done && (
        <div className="ml-6.5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-cream-deep/60 px-3 py-2">
          <span>{others.count === 1 ? "Another thread is" : `${others.count} other threads are`} stopped on the same limit.</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void others.switchThem().finally(() => {
                setBusy(false);
                setDone(true);
              });
            }}
          >
            {busy && <Spinner />}
            Switch {others.count === 1 ? "it" : "them"} too
          </Button>
        </div>
      )}
    </div>
  );
}
