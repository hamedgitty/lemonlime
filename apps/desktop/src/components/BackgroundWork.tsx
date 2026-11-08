import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ListTree, Clock, Hourglass, SquareTerminal, X } from "lucide-react";
import type { BackgroundWork, ChildWork } from "@lemonlime/protocol";
import { Spinner, cx } from "./ui.tsx";

export interface HeldMessage {
  id: string;
  text: string;
}

/** Rows shown before "Show more". Every row has the same height, so the card never reflows. */
const ROWS_SHOWN = 3;

/**
 * Above the composer: subagents still working and commands the agent left running, plus
 * messages held (⌥Enter) until the subagents finish. One fixed-height row each.
 */
export function BackgroundWorkCard({
  work,
  held,
  onSendHeld,
  onCancelHeld,
}: {
  work: BackgroundWork;
  held: HeldMessage[];
  onSendHeld: (id: string) => void;
  onCancelHeld: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [more, setMore] = useState(false);
  const bodyId = useId();
  const now = useMinuteClock();
  const busy = work.children.filter(c => c.state === "running" || c.state === "waiting");
  if (!busy.length && !work.commands.length && !held.length) return null;

  const rows = [
    ...held.map(h => ({ key: `held:${h.id}`, row: <HeldRow key={h.id} held={h} onSend={() => onSendHeld(h.id)} onCancel={() => onCancelHeld(h.id)} /> })),
    ...busy.map(c => ({ key: `child:${c.id}`, row: <ChildRow key={c.id} child={c} now={now} /> })),
    ...work.commands.map(c => ({
      key: `cmd:${c.id}`,
      row: (
        <Row
          key={c.id}
          icon={<SquareTerminal aria-hidden="true" className="size-3.5 text-ink-soft" />}
          label="Command in the background"
          meta={since(c.startedAt, now)}
        >
          <span className={cx("truncate text-ink", !c.description && "font-mono text-[13px]")} title={c.command}>
            {c.description ?? c.command}
          </span>
        </Row>
      ),
    })),
  ];
  const shown = more ? rows : rows.slice(0, ROWS_SHOWN);
  const summary = [
    busy.length ? `${busy.length} ${busy.length === 1 ? "subagent" : "subagents"}` : "",
    work.commands.length ? `${work.commands.length} ${work.commands.length === 1 ? "command" : "commands"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <section aria-label="Background work" className="mb-2 rounded-xl border border-line bg-paper shadow-panel">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
        className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[14px] hover:bg-cream-deep focus-visible:-outline-offset-2"
      >
        <ListTree aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
        <span className="shrink-0 font-medium text-ink">In the background</span>
        <span className="min-w-0 flex-1 truncate text-ink-faint tabular-nums">
          {summary || (held.length ? `${held.length} held ${held.length === 1 ? "message" : "messages"}` : "")}
        </span>
        <ChevronDown aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint", open && "rotate-180")} />
      </button>
      {open && (
        <ul id={bodyId} className="border-t border-line px-1.5 py-1">
          {shown.map(r => (
            <li key={r.key}>{r.row}</li>
          ))}
          {rows.length > ROWS_SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setMore(m => !m)}
                className="flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px] text-ink-soft hover:bg-cream-deep"
              >
                {more ? "Show fewer" : `Show ${rows.length - ROWS_SHOWN} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function Row({ icon, label, meta, children, actions }: { icon: ReactNode; label: string; meta?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-[14px]">
      <span className="inline-flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="sr-only">{label}: </span>
      <span className="flex min-w-0 flex-1">{children}</span>
      {meta && <span className="shrink-0 text-[13px] text-ink-faint tabular-nums">{meta}</span>}
      {actions}
    </div>
  );
}

function ChildRow({ child, now }: { child: ChildWork; now: number }) {
  const waiting = child.state === "waiting";
  return (
    <Row
      icon={waiting ? <Hourglass aria-hidden="true" className="size-3.5 text-amber" /> : <Spinner className="size-3 text-leaf" />}
      label={waiting ? "Subagent waiting on its own subagents" : "Subagent working"}
      meta={waiting ? "Waiting" : since(child.startedAt, now)}
    >
      <span className="truncate text-ink" title={child.title}>
        {child.title}
      </span>
    </Row>
  );
}

function HeldRow({ held, onSend, onCancel }: { held: HeldMessage; onSend: () => void; onCancel: () => void }) {
  return (
    <Row
      icon={<Clock aria-hidden="true" className="size-3.5 text-ink-soft" />}
      label="Sends when the subagents finish"
      actions={
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onSend}
            className="inline-flex h-6 items-center rounded-md px-2 text-[13px] font-medium text-ink-soft hover:bg-cream-deep hover:text-ink"
          >
            Send now
          </button>
          <button
            type="button"
            aria-label="Don't send this message"
            onClick={onCancel}
            className="inline-flex size-6 items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      }
    >
      <span className="shrink-0 text-ink-soft">After the subagents:</span>
      <span className="ml-1.5 truncate text-ink" title={held.text}>
        {held.text}
      </span>
    </Row>
  );
}

/** "now", "4m", "1h 5m" since an ISO time. */
export function since(iso: string, now: number): string {
  const mins = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
