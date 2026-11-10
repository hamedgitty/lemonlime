import { useState } from "react";
import { AlarmClock, Bell, CircleAlert, CircleCheck, MessageCircleQuestion, SkipForward } from "lucide-react";
import { relativeTime } from "../lib/format.ts";
import { unreadCount, type Inbox, type InboxItem, type InboxKind } from "../lib/inbox.ts";
import { Popover } from "./primitives.tsx";
import { cx } from "./ui.tsx";

const KIND: Record<InboxKind, { label: string; icon: typeof Bell; className: string }> = {
  finished: { label: "Finished", icon: CircleCheck, className: "text-leaf" },
  waiting: { label: "Waiting for you", icon: MessageCircleQuestion, className: "text-ink" },
  failed: { label: "Failed", icon: CircleAlert, className: "text-danger" },
  "automation-ran": { label: "Automation ran", icon: AlarmClock, className: "text-leaf" },
  "automation-skipped": { label: "Automation skipped", icon: SkipForward, className: "text-ink-soft" },
  "automation-failed": { label: "Automation failed", icon: CircleAlert, className: "text-danger" },
};

/** The bell in the sidebar footer: what happened lately across threads, newest first. */
export function NotificationCenter({
  inbox,
  onOpen,
  onMarkAllRead,
  className,
}: {
  inbox: Inbox;
  onOpen: (item: InboxItem) => void;
  onMarkAllRead: () => void;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const unread = unreadCount(inbox);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      className="w-[340px]"
      trigger={
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}
          title="Notifications"
          className={cx(className, "relative")}
        >
          <Bell aria-hidden="true" />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-lime px-1 text-[12px] font-semibold text-on-citrus tabular-nums"
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      }
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="flex-1 text-[14px] font-semibold">Notifications</p>
        <button
          type="button"
          disabled={!unread}
          onClick={onMarkAllRead}
          className="text-[13px] font-medium text-leaf hover:text-leaf-deep disabled:cursor-default disabled:text-ink-faint"
        >
          Mark all read
        </button>
      </div>
      {inbox.items.length === 0 ? (
        <p className="px-3 py-6 text-center text-[14px] text-ink-soft">Nothing yet. When an agent finishes, needs you or fails, it shows up here.</p>
      ) : (
        <ul className="scroll-thin max-h-[420px] overflow-y-auto p-1">
          {inbox.items.map(item => {
            const k = KIND[item.kind];
            const Icon = k.icon;
            const body = (
              <>
                <Icon aria-hidden="true" className={cx("mt-0.5 size-4 shrink-0", k.className)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cx("min-w-0 flex-1 truncate text-[14px]", !item.read && "font-semibold")}>{item.title || "Untitled thread"}</span>
                    <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{relativeTime(item.at)}</span>
                  </span>
                  <span className="block truncate text-[13px] text-ink-soft">
                    {k.label}
                    {item.detail ? `: ${item.detail}` : ""}
                  </span>
                </span>
                {!item.read && <span aria-label="New" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-lime-2" />}
              </>
            );
            return (
              <li key={item.id}>
                {item.thread ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpen(item);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-[7px] px-2.5 py-2 text-left hover:bg-cream-deep"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-2.5 px-2.5 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Popover>
  );
}
