import { useId, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, Clock, MoreHorizontal, Pencil, ShieldQuestionMark, Trash2, X } from "lucide-react";
import type { ApprovalItem, QueuedMessage } from "../lib/timeline.ts";
import type { EditDraft } from "../lib/messageActions.ts";
import type { EditQueuedFn } from "../lib/useThreadSession.ts";
import { clockTime } from "../lib/format.ts";
import { Menu, MenuItem, MenuSeparator } from "./primitives.tsx";
import { Button, Spinner, cx } from "./ui.tsx";

/**
 * The stack above the composer: what's waiting on the user (approvals) and what the user
 * has waiting for the agent (queued messages, a message being edited). Each card has the
 * same look as the to-do and background cards beside it, and rows of one fixed height, so
 * the composer stays where it is as things come and go.
 */

export type ApproveFn = (requestId: string, decision: "allow" | "deny") => void;

/** Rows shown before "Show more". */
const ROWS_SHOWN = 3;

const COMMAND_TOOLS = /^(bash|shell|execute|run|terminal)/i;

/** The agent asks to do something: a paper card with a lemon edge, so it isn't mistaken for your own message. */
export function ApprovalCard({ item, onApprove, more }: { item: ApprovalItem; onApprove?: ApproveFn | undefined; more: number }) {
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);
  const isCommand = COMMAND_TOOLS.test(item.tool);
  const answer = (decision: "allow" | "deny") => {
    if (sent || !onApprove) return;
    setSent(decision);
    onApprove(item.requestId, decision);
  };
  return (
    <section
      aria-label="The agent is asking for permission"
      className="relative mb-2 overflow-hidden rounded-xl border border-line bg-paper py-3 pr-3 pl-4 shadow-panel before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-lemon-2"
    >
      <div className="flex items-center gap-2 text-[14px]">
        <ShieldQuestionMark aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
        <p className="min-w-0 flex-1 font-medium text-ink">{isCommand ? "The agent wants to run this command" : `The agent wants to use ${item.tool}`}</p>
        {more > 0 && <span className="shrink-0 text-[13px] text-ink-faint tabular-nums">{more} more waiting</span>}
      </div>
      <pre className="scroll-thin mt-2 max-h-32 overflow-auto rounded-lg bg-cream px-3 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
        {item.summary}
      </pre>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {/* Neither button takes focus by itself, so a stray Enter never approves anything. */}
        <Button variant="primary" size="sm" disabled={sent !== null || !onApprove} onClick={() => answer("allow")}>
          {sent === "allow" && <Spinner />}
          Allow
        </Button>
        <Button variant="secondary" size="sm" disabled={sent !== null || !onApprove} onClick={() => answer("deny")}>
          {sent === "deny" && <Spinner />}
          Don&apos;t allow
        </Button>
        <span className="ml-auto text-[13px] text-ink-faint">The agent waits for your answer.</span>
      </div>
    </section>
  );
}

/** The card frame every collapsible stack card shares: a one-line header that opens to fixed-height rows. */
function StackCard({ label, icon, title, summary, children }: { label: string; icon: ReactNode; title: ReactNode; summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section aria-label={label} className="mb-2 rounded-xl border border-line bg-paper shadow-panel">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(o => !o)}
        className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[14px] hover:bg-cream-deep focus-visible:-outline-offset-2"
      >
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-ink-soft">{icon}</span>
        <span className="shrink-0 font-medium text-ink">{title}</span>
        <span className="min-w-0 flex-1 truncate text-ink-faint tabular-nums">{summary}</span>
        <ChevronDown aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint", open && "rotate-180")} />
      </button>
      {open && (
        <div id={bodyId} className="border-t border-line px-1.5 py-1">
          {children}
        </div>
      )}
    </section>
  );
}

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/** Messages waiting for the agent: send one now, edit it, move it or take it back. */
export function QueuedCard({ queued, onEdit }: { queued: QueuedMessage[]; onEdit: EditQueuedFn }) {
  const [more, setMore] = useState(false);
  if (!queued.length) return null;
  const shown = more ? queued : queued.slice(0, ROWS_SHOWN);
  return (
    <StackCard
      label="Queued messages"
      icon={<Clock aria-hidden="true" className="size-4" />}
      title={queued.length === 1 ? "1 message queued" : `${queued.length} messages queued`}
      summary="They go when the agent finishes"
    >
      <ul>
        {shown.map(q => (
          <li key={q.clientMsgId}>
            <QueuedRow q={q} onEdit={onEdit} />
          </li>
        ))}
        {queued.length > ROWS_SHOWN && (
          <li>
            <button
              type="button"
              onClick={() => setMore(m => !m)}
              className="flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px] text-ink-soft hover:bg-cream-deep"
            >
              {more ? "Show fewer" : `Show ${queued.length - ROWS_SHOWN} more`}
            </button>
          </li>
        )}
      </ul>
    </StackCard>
  );
}

function QueuedRow({ q, onEdit }: { q: QueuedMessage; onEdit: EditQueuedFn }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(q.text);
  const id = q.clientMsgId;
  const save = () => {
    const next = draft.trim();
    if (next && next !== q.text) onEdit(id, { action: "update", text: next });
    setEditing(false);
  };
  if (editing)
    return (
      <div className="my-1 rounded-lg border border-line-strong bg-paper p-1.5">
        <textarea
          aria-label="Edit queued message"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- it opens because the person just chose Edit
          autoFocus
          onFocus={e => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              setDraft(q.text);
              setEditing(false);
            }
          }}
          rows={Math.min(6, Math.max(2, draft.split("\n").length))}
          className="w-full resize-none rounded-md bg-transparent px-2 py-1 text-[14px] text-ink outline-none"
        />
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(q.text);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    );
  return (
    <div className="group/queued flex h-8 items-center gap-2.5 rounded-lg px-2 text-[14px]">
      <span className="w-8 shrink-0 text-[13px] text-ink-faint tabular-nums">{q.count > 1 ? ordinal(q.index + 1) : ""}</span>
      <span className="min-w-0 flex-1 truncate text-ink" title={q.text}>
        {q.text}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onEdit(id, { action: "send_now" })}
          className="inline-flex h-6 items-center rounded-md px-2 text-[13px] font-medium text-ink-soft hover:bg-cream-deep hover:text-ink"
        >
          Send now
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(q.text);
            setEditing(true);
          }}
          className="inline-flex h-6 items-center rounded-md px-2 text-[13px] font-medium text-ink-soft hover:bg-cream-deep hover:text-ink"
        >
          Edit
        </button>
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              aria-label="More for this queued message"
              className="inline-flex size-6 items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink data-[popup-open]:bg-cream-deep"
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </button>
          }
        >
          <MenuItem icon={<ArrowUpToLine />} disabled={q.index === 0} onSelect={() => onEdit(id, { action: "move", toIndex: 0 })}>
            Move to front
          </MenuItem>
          <MenuItem icon={<ArrowDownToLine />} disabled={q.index === q.count - 1} onSelect={() => onEdit(id, { action: "move", toIndex: q.count - 1 })}>
            Move to back
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} onSelect={() => onEdit(id, { action: "remove" })}>
            Remove from queue
          </MenuItem>
        </Menu>
      </span>
    </div>
  );
}

/** Editing a message you sent: says what sending will do, with a way to change that or stop. */
export function EditingCard({ draft, onReplace, onCancel }: { draft: EditDraft; onReplace: (replace: boolean) => void; onCancel: () => void }) {
  return (
    <section
      aria-label="Editing a message"
      className="mb-2 flex h-10 items-center gap-2.5 rounded-xl border border-line bg-paper px-3 text-[14px] shadow-panel"
    >
      <Pencil aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
      <span className="shrink-0 font-medium text-ink">Editing your message</span>
      <span className="min-w-0 flex-1 truncate text-ink-faint">
        {draft.replace ? `Sending replaces it and what came after (from ${clockTime(draft.at)})` : "Sending adds it as a new message"}
      </span>
      {draft.canReplace && (
        <button
          type="button"
          onClick={() => onReplace(!draft.replace)}
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[13px] font-medium text-ink-soft hover:bg-cream-deep hover:text-ink"
        >
          {draft.replace ? "Send as new instead" : "Replace instead"}
        </button>
      )}
      <button
        type="button"
        aria-label="Stop editing"
        onClick={onCancel}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </section>
  );
}
