import { cx } from "./ui.tsx";

/** The shape of a conversation while its history loads: a message, a few steps, a reply. */
export function HistorySkeleton() {
  const bar = "rounded-md bg-cream-deep animate-pulse-soft";
  return (
    <div role="status" aria-label="Loading the conversation" className="flex flex-col">
      <div className="flex justify-end">
        <div className={cx(bar, "h-10 w-[46%] rounded-2xl rounded-br-md")} />
      </div>
      <div className="mt-6 flex flex-col gap-2.5 pl-1.5">
        {[38, 52, 30].map(w => (
          <div key={w} className="flex items-center gap-2">
            <div className={cx(bar, "size-3.5")} />
            <div className={bar} style={{ width: `${w}%`, height: 12 }} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-3">
        <div className={cx(bar, "size-[22px] shrink-0 rounded-full")} />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <div className={bar} style={{ width: "88%", height: 12 }} />
          <div className={bar} style={{ width: "72%", height: 12 }} />
          <div className={bar} style={{ width: "40%", height: 12 }} />
        </div>
      </div>
    </div>
  );
}
