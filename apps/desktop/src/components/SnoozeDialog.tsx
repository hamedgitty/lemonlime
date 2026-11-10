import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { snoozeWhen } from "../lib/threadMenu.ts";
import { Button, TextInput } from "./ui.tsx";

/** "2026-11-09T09:00" in local time, as a datetime-local field holds it. */
function localValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tomorrowAtNine(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** Snooze a thread until a date and time of your own. */
export function SnoozeDialog({ title, onSnooze, onClose }: { title: string | null; onSnooze: (until: Date) => void; onClose: () => void }) {
  const [value, setValue] = useState(() => localValue(tomorrowAtNine()));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (title !== null) setValue(localValue(tomorrowAtNine()));
  }, [title]);
  const until = value ? new Date(value) : null;
  const now = new Date();
  const valid = until !== null && !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
  const submit = () => {
    if (!valid || !until) return;
    onSnooze(until);
    onClose();
  };
  return (
    <Dialog.Root open={title !== null} onOpenChange={o => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim/20 transition-opacity duration-[250ms] ease-(--ease-out) data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          initialFocus={input}
          className="fixed top-[22vh] left-1/2 z-50 w-[min(380px,calc(100vw-32px))] -translate-x-1/2 rounded-2xl border border-line bg-paper p-5 text-ink shadow-pop outline-none transition-[opacity,scale] duration-[250ms] ease-(--ease-out) data-[ending-style]:scale-[0.99] data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0"
        >
          <Dialog.Title className="text-[15px] font-semibold text-balance">Snooze until…</Dialog.Title>
          <Dialog.Description className="mt-1 text-[14px] break-words text-ink-soft">
            “{title}” leaves the list until then, or until its agent needs you.
          </Dialog.Description>
          <form
            className="mt-4"
            onSubmit={e => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="block text-[13px] font-medium text-ink-soft" htmlFor="snooze-until">
              Date and time
            </label>
            <TextInput
              ref={input}
              id="snooze-until"
              type="datetime-local"
              value={value}
              min={localValue(now)}
              onChange={e => setValue(e.target.value)}
              className="mt-1.5 tabular-nums"
            />
            <p className="mt-2 h-5 text-[13px] text-ink-soft" aria-live="polite">
              {until && !Number.isNaN(until.getTime())
                ? valid
                  ? `Back ${snoozeWhen(until, now).replace(/^(\d)/, "at $1")}.`
                  : "Pick a time that hasn't passed yet."
                : ""}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!valid}>
                Snooze
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
