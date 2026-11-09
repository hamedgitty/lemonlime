import type { ReactElement } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import type { ThreadCardLine } from "../lib/threadCard.ts";

/**
 * The card a sidebar row shows after the pointer rests on it: where the thread lives and
 * what it's doing. One card for the whole list; each row hands it its own lines.
 */
export interface ThreadCardPayload {
  title: string;
  lines: ThreadCardLine[];
}

const handle = PreviewCard.createHandle<ThreadCardPayload>();

/** How long the pointer rests on a row before its card shows, and lingers after. */
const OPEN_DELAY = 550;
const CLOSE_DELAY = 80;

/** Mount once, in the sidebar. */
export function ThreadPeek() {
  return (
    <PreviewCard.Root handle={handle}>
      {({ payload }) =>
        payload ? (
          <PreviewCard.Portal>
            <PreviewCard.Positioner side="right" align="start" sideOffset={14} className="z-50">
              <PreviewCard.Popup
                // Only on a resting pointer, so it may fade; it never moves.
                className="w-[272px] rounded-xl border border-line bg-paper px-3.5 py-3 text-ink shadow-pop outline-none transition-opacity duration-150 ease-(--ease-out) data-[ending-style]:opacity-0 data-[ending-style]:duration-100 data-[starting-style]:opacity-0"
              >
                <p className="line-clamp-2 text-[14px] font-semibold break-words text-pretty">{payload.title}</p>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                  {payload.lines.map(l => (
                    <div key={l.label} className="contents">
                      <dt className="text-ink-faint">{l.label}</dt>
                      <dd className="truncate text-ink-soft" title={l.value}>
                        {l.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </PreviewCard.Popup>
            </PreviewCard.Positioner>
          </PreviewCard.Portal>
        ) : null
      }
    </PreviewCard.Root>
  );
}

/** Makes `render` (a row's button) show the card for it. */
export function ThreadPeekTrigger({ payload, render }: { payload: ThreadCardPayload; render: ReactElement }) {
  return <PreviewCard.Trigger handle={handle} payload={payload} delay={OPEN_DELAY} closeDelay={CLOSE_DELAY} render={render} />;
}
