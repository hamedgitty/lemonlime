import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button, cx } from "./ui.tsx";

export function Composer({
  onSend,
  onInterrupt,
  working,
  disabled,
  disabledReason,
}: {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** The agent is in the middle of a turn: show the interrupt button. */
  working: boolean;
  disabled: boolean;
  disabledReason?: string | undefined;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    if (disabled || !text.trim()) return;
    onSend(text);
    setText("");
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && working) {
      e.preventDefault();
      onInterrupt();
    }
  };

  const canSend = !disabled && text.trim().length > 0;

  return (
    <div className="border-t border-line bg-cream/80 px-6 pt-3 pb-4 backdrop-blur">
      <div className="mx-auto max-w-[860px]">
        <div
          className={cx(
            "flex items-end gap-2 rounded-2xl border bg-white p-2 pl-4 shadow-panel transition-[border-color,box-shadow] duration-150",
            "border-control focus-within:border-leaf focus-within:shadow-[0_0_0_1px_var(--color-leaf)]",
          )}
        >
          <label htmlFor="composer" className="sr-only">
            Message the agent
          </label>
          <textarea
            id="composer"
            ref={ref}
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? (disabledReason ?? "Not connected") : working ? "Add to the conversation…" : "Ask the agent to do something…"}
            aria-describedby="composer-hint"
            className="max-h-60 min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
          />
          {working && (
            <Button variant="secondary" size="md" onClick={onInterrupt} aria-label="Interrupt the agent" title="Interrupt (Esc)">
              <Square aria-hidden="true" className="size-3.5 fill-current" />
              Stop
            </Button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            title="Send (Enter)"
            className={cx(
              "inline-flex size-9.5 shrink-0 items-center justify-center rounded-xl border transition-colors",
              canSend ? "border-[#e9c900] bg-lemon text-ink hover:bg-[#ffe84f]" : "border-line bg-cream-deep text-ink-faint",
            )}
          >
            <ArrowUp aria-hidden="true" className="size-4.5" strokeWidth={2.4} />
          </button>
        </div>
        <p id="composer-hint" className="mt-1.5 pl-1 text-xs text-ink-faint">
          Enter to send, Shift+Enter for a new line{working ? ", Esc to stop the agent" : ""}
        </p>
      </div>
    </div>
  );
}
