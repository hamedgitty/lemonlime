import { useEffect, useState, type RefObject } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { clockTime } from "../lib/format.ts";
import type { Toc } from "../lib/timelineView.ts";
import { SegmentedControl, cx } from "./ui.tsx";

/**
 * A thin rail of ticks on the timeline's right edge, one per message the user sent. Hovering
 * (or focusing and pressing Enter) opens the list of messages, yours or the agent's answers;
 * picking one scrolls to it. Only shown on wide windows (see the container query in Timeline).
 */
export function MessageRail({ toc, scrollRef, onJump }: { toc: Toc; scrollRef: RefObject<HTMLDivElement | null>; onJump: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"you" | "agent">("you");
  const active = useActiveKey(toc, scrollRef);
  const list = tab === "you" ? toc.you : toc.agent;
  const height = Math.min(toc.you.length * 10, 320);

  return (
    <BasePopover.Root open={open} onOpenChange={o => setOpen(o)}>
      <BasePopover.Trigger
        openOnHover
        delay={120}
        closeDelay={200}
        aria-label="Jump to a message"
        className="absolute top-1/2 right-2 z-10 hidden -translate-y-1/2 rounded-lg px-1.5 py-2 hover:bg-ink/5 @min-[1080px]:block data-[popup-open]:bg-ink/5"
      >
        <span className="flex flex-col items-end justify-between" style={{ height }}>
          {toc.you.map(e => (
            <span
              key={e.key}
              className={cx("block h-0.5 shrink-0 rounded-full transition-colors duration-150", e.key === active ? "w-4 bg-ink" : "w-2.5 bg-line-strong")}
            />
          ))}
        </span>
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner side="left" align="center" sideOffset={8} className="z-50">
          <BasePopover.Popup className="flex max-h-[min(480px,70vh)] w-[min(360px,calc(100vw-48px))] origin-(--transform-origin) flex-col rounded-[12px] border border-line bg-paper text-ink shadow-pop outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
            <div className="shrink-0 p-2 pb-1.5">
              <SegmentedControl
                label="Show messages from"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "you", label: `You (${toc.you.length})` },
                  { value: "agent", label: `Agent (${toc.agent.length})` },
                ]}
              />
            </div>
            <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1 pb-1">
              {list.length === 0 && <li className="px-2.5 py-2 text-[13px] text-ink-faint">No answers yet.</li>}
              {list.map(e => (
                <li key={e.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onJump(e.key);
                    }}
                    className={cx(
                      "flex w-full items-baseline gap-3 rounded-[8px] px-2.5 py-1.5 text-left text-[14px] hover:bg-cream-deep",
                      e.key === active && "font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">{clockTime(e.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

/** The sent message the reader is at: the last one whose top is above the upper third of the view. */
function useActiveKey(toc: Toc, scrollRef: RefObject<HTMLDivElement | null>): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = el.getBoundingClientRect().top + el.clientHeight / 3;
      let current: string | null = toc.you[0]?.key ?? null;
      for (const e of toc.you) {
        const node = el.querySelector<HTMLElement>(`[data-timeline-key="${e.key}"]`);
        if (!node) continue;
        if (node.getBoundingClientRect().top <= line) current = e.key;
        else break;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [toc, scrollRef]);
  return active;
}
