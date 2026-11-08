import { useState, type DragEvent, type KeyboardEvent } from "react";
import { Check, CircleCheck, Copy, EyeOff, Eye, GripVertical, LogOut, Minus, MoreHorizontal, RefreshCw, Star, UserRound } from "lucide-react";
import { hasAccounts } from "@lemonlime/protocol";
import { AGENT_LABELS } from "../../lib/format.ts";
import { harnessRows, moveAgent, orderedAgents, type HarnessRow } from "../../lib/models.ts";
import { confirmAction, inDesktopShell } from "../../lib/native.ts";
import type { AgentsTabRequest } from "../../lib/settingsNav.ts";
import { installAgent, signOutAgent, TESTED_AGENTS } from "../../lib/system.ts";
import { AgentIcon } from "../AgentIcon.tsx";
import { Menu, MenuItem, MenuSeparator, Popover, Tip, Toggle } from "../primitives.tsx";
import { Button, IconButton, Spinner, cx } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { code, ErrorText, Pill } from "./parts.tsx";

/**
 * Settings → Agents → Harness: every agent LemonLime supports, one row each. Installed ones
 * first, in the user's order (drag the handle, or focus it and use the arrow keys); that
 * order is the order of the model picker's tabs.
 */
export function HarnessTab({ ctx, onTab }: { ctx: SettingsCtx; onTab: (req: AgentsTabRequest) => void }) {
  const { prefs, onPrefs } = ctx;
  const shell = inDesktopShell();
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ kind: string; ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<HarnessRow["kind"] | null>(null);
  const [moved, setMoved] = useState("");
  const { installed, notInstalled } = harnessRows({
    agents: ctx.agents,
    order: prefs.agentOrder,
    hidden: prefs.hiddenAgents,
    defaultAgent: prefs.lastAgent,
    autoUpdate: prefs.autoUpdateAgents,
  });

  const run = async (kind: HarnessRow["kind"]) => {
    setBusy(kind);
    setOutput(null);
    try {
      const text = await installAgent(kind);
      setOutput({ kind, ok: true, text });
    } catch (err) {
      setOutput({ kind, ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      ctx.refreshAgents();
    }
  };

  const signOut = async (kind: HarnessRow["kind"]) => {
    if (!(await confirmAction(`Sign ${AGENT_LABELS[kind]} out on this computer? Threads that use it stop until you sign in again.`))) return;
    setBusy(kind);
    setError(null);
    try {
      await signOutAgent(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      ctx.refreshAgents();
    }
  };

  // Moving only reorders the installed agents; the rest keep their places after them.
  const place = (kind: HarnessRow["kind"], to: number) => {
    const visible = installed.map(r => r.kind);
    const next = moveAgent(visible, kind, to);
    onPrefs({ agentOrder: orderedAgents([...next.filter(k => visible.includes(k as HarnessRow["kind"])), ...prefs.agentOrder]) });
    setMoved(`${AGENT_LABELS[kind]} moved to place ${Math.max(1, Math.min(to + 1, visible.length))} of ${visible.length}.`);
  };
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, kind: HarnessRow["kind"], i: number) => {
    const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? installed.length - 1 : null;
    if (to === null || to < 0 || to >= installed.length) return;
    e.preventDefault();
    place(kind, to);
    // Keep the focus on the handle that moved.
    requestAnimationFrame(() => document.getElementById(`harness-handle-${kind}`)?.focus());
  };
  const onDrop = (e: DragEvent, to: number) => {
    e.preventDefault();
    if (dragging) place(dragging, to);
    setDragging(null);
  };

  const testedVersion = (kind: string) => TESTED_AGENTS.find(t => t.kind === kind)?.version;

  return (
    <section className="mb-8" data-setting="Harness">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-[15px] font-semibold tracking-normal">Harness</h3>
          <p className="mt-0.5 text-[14px] text-ink-soft">
            Your agents: versions, sign-in, updates and the default. Drag to set the order of the model picker's tabs.
          </p>
        </div>
        <IconButton label="Check again" onClick={ctx.refreshAgents} disabled={!shell || ctx.agents === null}>
          {ctx.agents === null ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-4" />}
        </IconButton>
      </div>
      {!shell && <p className="mt-3 text-[14px] text-ink-soft">Agent detection works in the desktop app, so every agent shows as not installed here.</p>}

      <div className="@container/harness mt-3 rounded-xl border border-line bg-paper px-3 py-1">
        <table className="w-full table-fixed border-collapse text-[14px]">
          <caption className="sr-only">Agents on this computer</caption>
          <thead>
            <tr className="border-b border-line text-left text-[13px] font-medium text-ink-faint">
              <th scope="col" className="w-7">
                <span className="sr-only">Order</span>
              </th>
              <th scope="col" className="py-2.5 pl-1 font-medium">
                Agent
              </th>
              <th scope="col" className="w-[56px] py-2 text-center font-medium whitespace-nowrap">
                <span title="Installed on this computer" aria-hidden="true">
                  Here
                </span>
                <span className="sr-only">On this computer</span>
              </th>
              <th scope="col" className={cx("w-[60px] py-2 text-center font-medium", GIVE_WAY_CLOUD)}>
                <span>Cloud</span>
              </th>
              <th scope="col" className={cx("w-[88px] py-2 text-center font-medium whitespace-nowrap", GIVE_WAY_UPDATE)}>
                <span>Auto-update</span>
              </th>
              <th scope="col" className="w-[88px] py-2 text-center font-medium whitespace-nowrap">
                Status
              </th>
              <th scope="col" className="w-9">
                <span className="sr-only">More</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {installed.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-center text-[14px] text-ink-soft">
                  {ctx.agents === null ? "Looking for agents…" : "No agents installed yet. Install one below."}
                </td>
              </tr>
            )}
            {installed.map((r, i) => (
              <tr
                key={r.kind}
                onDragOver={e => dragging && e.preventDefault()}
                onDrop={e => onDrop(e, i)}
                className={cx("border-b border-line last:border-b-0", dragging === r.kind && "opacity-50", r.hidden && "text-ink-soft")}
              >
                <td className="py-2.5">
                  <Tip label="Drag, or use the arrow keys, to reorder">
                    <button
                      id={`harness-handle-${r.kind}`}
                      type="button"
                      draggable
                      aria-label={`Reorder ${AGENT_LABELS[r.kind]}, place ${i + 1} of ${installed.length}`}
                      onDragStart={e => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", r.kind);
                        setDragging(r.kind);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onKeyDown={e => onHandleKey(e, r.kind, i)}
                      className="inline-flex h-8 w-6 cursor-grab items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink active:cursor-grabbing"
                    >
                      <GripVertical aria-hidden="true" className="size-4" />
                    </button>
                  </Tip>
                </td>
                <AgentCell row={r} />
                <td className="text-center">
                  <Check aria-label="Installed" className="inline size-4 text-leaf" />
                </td>
                <CloudCell row={r} />
                <td className={cx("text-center", GIVE_WAY_UPDATE)}>
                  {r.autoUpdate === "unavailable" ? (
                    <span title="Not installed with npm, so it updates itself or by hand" className="inline-flex">
                      <Minus aria-label="Not installed with npm" className="size-4 text-ink-faint" />
                    </span>
                  ) : (
                    <span className="inline-flex align-middle">
                      <Toggle
                        label={`Keep ${AGENT_LABELS[r.kind]} up to date`}
                        checked={r.autoUpdate === "on"}
                        onChange={on =>
                          onPrefs({
                            autoUpdateAgents: on ? [...new Set([...prefs.autoUpdateAgents, r.kind])] : prefs.autoUpdateAgents.filter(k => k !== r.kind),
                          })
                        }
                      />
                    </span>
                  )}
                </td>
                <td className="text-center">
                  <StatusCell row={r} busy={busy} onUpdate={() => void run(r.kind)} onSignIn={() => onTab({ tab: "accounts", agent: r.kind })} />
                </td>
                <td className="text-right">
                  <Menu
                    align="end"
                    trigger={
                      <button
                        type="button"
                        aria-label={`More for ${AGENT_LABELS[r.kind]}`}
                        className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink data-[popup-open]:bg-cream-deep"
                      >
                        <MoreHorizontal aria-hidden="true" className="size-4" />
                      </button>
                    }
                  >
                    <MenuItem icon={<Star />} disabled={r.isDefault} onSelect={() => onPrefs({ lastAgent: r.kind })}>
                      {r.isDefault ? "The default" : "Make default"}
                    </MenuItem>
                    {hasAccounts(r.kind) && (
                      <MenuItem icon={<UserRound />} onSelect={() => onTab({ tab: "accounts", agent: r.kind })}>
                        Accounts…
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem icon={<LogOut />} disabled={r.kind === "opencode" || busy !== null} onSelect={() => void signOut(r.kind)}>
                      {r.kind === "opencode" ? "Sign out with opencode auth logout" : "Sign out"}
                    </MenuItem>
                    <MenuItem
                      icon={r.hidden ? <Eye /> : <EyeOff />}
                      onSelect={() => onPrefs({ hiddenAgents: r.hidden ? prefs.hiddenAgents.filter(k => k !== r.kind) : [...prefs.hiddenAgents, r.kind] })}
                    >
                      {r.hidden ? "Show in LemonLime" : "Hide from LemonLime"}
                    </MenuItem>
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
          {notInstalled.length > 0 && (
            <tbody>
              <tr>
                <th colSpan={7} scope="rowgroup" className="pt-4 pb-1 pl-1 text-left text-[13px] font-medium text-ink-faint">
                  Not installed
                </th>
              </tr>
              {notInstalled.map(r => (
                <tr key={r.kind} className="border-t border-line">
                  <td />
                  <AgentCell row={r} />
                  <td className="text-center">
                    <Minus aria-label="Not installed" className="inline size-4 text-ink-faint" />
                  </td>
                  <CloudCell row={r} />
                  <td className={cx("text-center", GIVE_WAY_UPDATE)}>
                    <Minus aria-hidden="true" className="inline size-4 text-ink-faint" />
                  </td>
                  <td className="py-2.5 text-center">
                    <Button size="sm" variant="secondary" disabled={!shell || busy !== null} onClick={() => void run(r.kind)}>
                      {busy === r.kind && <Spinner />}
                      Install
                    </Button>
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          )}
        </table>
        <p role="status" className="sr-only">
          {moved}
        </p>
      </div>
      {output && (
        <pre
          role="status"
          className={cx(
            "mt-3 max-h-48 overflow-auto rounded-lg border px-3 py-2 font-mono text-[12px] whitespace-pre-wrap",
            output.ok ? "border-line bg-cream" : "border-danger/30 bg-danger-soft text-danger",
          )}
        >
          {output.ok ? `${AGENT_LABELS[output.kind as HarnessRow["kind"]]} is installed.\n${output.text}` : output.text}
        </pre>
      )}
      <div className="mt-2">
        <ErrorText>{error}</ErrorText>
      </div>
      <p className="mt-3 text-[14px] text-ink-soft">
        Installing and updating use npm, which comes with Node.js. LemonLime is tested with{" "}
        {installed
          .concat(notInstalled)
          .map(r => `${AGENT_LABELS[r.kind]} ${testedVersion(r.kind)}`)
          .join(", ")}
        . Any agent that speaks the Agent Client Protocol works too: add it under ACP agents.
      </p>
    </section>
  );
}

/*
 * Columns that give way in a narrow window. They shrink to nothing rather than disappear:
 * a fixed-layout table would otherwise hand their room to empty columns, not to the names.
 */
const GIVE_WAY_CLOUD = "overflow-hidden @max-[600px]/harness:w-0 @max-[600px]/harness:px-0 @max-[600px]/harness:*:hidden";
const GIVE_WAY_UPDATE = "overflow-hidden @max-[560px]/harness:w-0 @max-[560px]/harness:px-0 @max-[560px]/harness:*:hidden";

function AgentCell({ row }: { row: HarnessRow }) {
  return (
    <td className="py-2.5 pl-1">
      <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        <AgentIcon kind={row.kind} color className="size-[18px] shrink-0" />
        {/* The name gives way last: the version, then the tags, go first in a narrow window. */}
        <span className="min-w-[5ch] shrink truncate font-medium text-ink" title={AGENT_LABELS[row.kind]}>
          {AGENT_LABELS[row.kind]}
        </span>
        {row.version && <span className="min-w-0 shrink-[2] truncate text-[13px] text-ink-faint tabular-nums @max-[600px]/harness:hidden">{row.version}</span>}
        {(row.isDefault || row.hidden) && (
          <span className="flex shrink-0 gap-1.5 @max-[540px]/harness:hidden">
            {row.isDefault && <Pill tone="good">Default</Pill>}
            {row.hidden && <Pill>Hidden</Pill>}
          </span>
        )}
      </span>
    </td>
  );
}

function CloudCell({ row }: { row: HarnessRow }) {
  return (
    <td className={cx("text-center", GIVE_WAY_CLOUD)}>
      {row.cloud ? (
        <Check aria-label="Runs in the cloud" className="inline size-4 text-leaf" />
      ) : (
        <span title="This computer only" className="inline-flex">
          <Minus aria-label="This computer only" className="size-4 text-ink-faint" />
        </span>
      )}
    </td>
  );
}

function StatusCell({ row, busy, onUpdate, onSignIn }: { row: HarnessRow; busy: string | null; onUpdate: () => void; onSignIn: () => void }) {
  if (row.status === "ready")
    return (
      <Tip label="Installed and signed in">
        <span className="inline-flex" tabIndex={0} role="img" aria-label="Installed and signed in">
          <CircleCheck aria-hidden="true" className="size-[18px] text-leaf" />
        </span>
      </Tip>
    );
  if (row.status === "update")
    return (
      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={onUpdate}>
        {busy === row.kind && <Spinner />}
        Update
      </Button>
    );
  if (row.status === "sign-in") {
    if (hasAccounts(row.kind))
      return (
        <Button size="sm" variant="secondary" onClick={onSignIn}>
          Sign in
        </Button>
      );
    return <SignInCommand kind={row.kind} />;
  }
  return <SignInCommand kind={row.kind} unknown />;
}

/** Agents LemonLime can't sign in by itself: the command to run in a terminal. */
function SignInCommand({ kind, unknown = false }: { kind: HarnessRow["kind"]; unknown?: boolean }) {
  const command = TESTED_AGENTS.find(t => t.kind === kind)?.signIn ?? "";
  const [copied, setCopied] = useState(false);
  return (
    <Popover
      align="end"
      className="w-[300px] p-3"
      trigger={
        unknown ? (
          // Installed, and it may well work signed out (OpenCode's free models do): a quiet
          // check that opens how to sign in, rather than a call to action.
          <button
            type="button"
            aria-label={`${AGENT_LABELS[kind]} is installed. How to sign it in`}
            title="Installed. Click for how to sign in."
            className="inline-flex size-7 items-center justify-center rounded-md hover:bg-cream-deep"
          >
            <CircleCheck aria-hidden="true" className="size-[18px] text-ink-faint" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Sign ${AGENT_LABELS[kind]} in`}
            className="h-7 rounded-md px-2 text-[13px] font-medium whitespace-nowrap text-leaf hover:bg-cream-deep hover:text-leaf-deep"
          >
            Sign in
          </button>
        )
      }
    >
      <p className="text-[14px] text-ink-soft">
        {unknown
          ? `${AGENT_LABELS[kind]} is installed. LemonLime can't tell whether it's signed in; it may work without (OpenCode's free models do). To sign in, run this in a terminal:`
          : "Run this in a terminal:"}
      </p>
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-cream px-2.5 py-1.5">
        <code className={cx(code, "min-w-0 flex-1 truncate")}>{command}</code>
        <IconButton
          label={copied ? "Copied" : `Copy ${command}`}
          className="size-7"
          onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}
        >
          {copied ? <Check aria-hidden="true" className="size-3.5 text-leaf" /> : <Copy aria-hidden="true" className="size-3.5" />}
        </IconButton>
      </div>
    </Popover>
  );
}
