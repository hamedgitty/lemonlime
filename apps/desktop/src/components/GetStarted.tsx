import { Check, X } from "lucide-react";
import { getStartedItems, type GetStartedFacts, type GetStartedStep } from "../lib/getStarted.ts";
import { cx } from "./ui.tsx";

const ACTION: Record<GetStartedStep, string> = {
  agent: "Set up",
  project: "Choose a folder",
  thread: "Write a message",
  cloud: "Try it",
  github: "Connect",
};

/** First steps for someone new. Each ticks itself from what's really set up. */
export function GetStarted({ facts, onStep, onDismiss }: { facts: GetStartedFacts; onStep: (id: GetStartedStep) => void; onDismiss: () => void }) {
  const items = getStartedItems(facts);
  const done = items.filter(i => i.done).length;
  return (
    <section aria-labelledby="get-started" className="mt-10 rounded-xl border border-line bg-paper px-4 pt-3.5 pb-2">
      <div className="flex items-center gap-2">
        <h2 id="get-started" className="font-sans text-[15px] font-semibold tracking-normal">
          Get started
        </h2>
        <span className="text-[13px] text-ink-soft tabular-nums">
          {done} of {items.length} done
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide the get started list"
          className="inline-flex size-7 items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <ul className="mt-1.5">
        {items.map(i => (
          <li key={i.id} className="flex h-10 items-center gap-3 border-t border-line first:border-t-0">
            <span
              aria-hidden="true"
              className={cx("inline-flex size-5 shrink-0 items-center justify-center rounded-full", i.done ? "bg-lime text-ink" : "border border-line-strong")}
            >
              {i.done && <Check className="size-3" strokeWidth={2.6} />}
            </span>
            <span className={cx("min-w-0 flex-1 truncate text-[14px]", i.done ? "text-ink-soft line-through decoration-line-strong" : "text-ink")}>
              {i.label}
              <span className="sr-only">{i.done ? ", done" : ", not done yet"}</span>
            </span>
            {!i.done && (
              <button type="button" onClick={() => onStep(i.id)} className="shrink-0 text-[14px] font-medium text-leaf hover:text-leaf-deep">
                {ACTION[i.id]}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
