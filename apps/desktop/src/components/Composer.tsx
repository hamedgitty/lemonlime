import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Tip } from "./primitives.tsx";
import { cx } from "./ui.tsx";

export interface ComposerHandle {
  /** Put text in the box (e.g. a one-click prompt) and focus it. */
  fill(text: string): void;
  focus(): void;
}

/**
 * The message card: a growing text box with a toolbar inside it. `tools` sits bottom-left
 * (agent and model pickers); the round send button turns lime once there's something
 * to send. Used on the home screen and docked under a thread.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (text: string) => void;
    onInterrupt?: () => void;
    /** The agent is in the middle of a turn: show the stop button. */
    working?: boolean;
    disabled?: boolean;
    disabledReason?: string | undefined;
    placeholder?: string;
    tools?: ReactNode;
    /** Keep the text after sending (e.g. while a thread is being created). */
    busy?: boolean;
    autoFocus?: boolean;
  }
>(function Composer({ onSend, onInterrupt, working = false, disabled = false, disabledReason, placeholder, tools, busy = false, autoFocus }, handle) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(handle, () => ({
    fill(t: string) {
      setText(t);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(t.length, t.length);
      });
    },
    focus: () => ref.current?.focus(),
  }));

  // Grow with the content up to a limit. Measure again when the width changes (the first
  // layout can happen before the column has its final width, which wraps the placeholder).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
    };
    fit();
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const canSend = !disabled && !busy && text.trim().length > 0;
  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && working && onInterrupt) {
      e.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div
      className={cx(
        "rounded-xl border border-line bg-paper shadow-panel transition-[border-color,box-shadow] duration-150",
        "focus-within:border-line-strong focus-within:shadow-[0_1px_2px_rgb(23_32_14/0.04),0_6px_20px_rgb(23_32_14/0.07)]",
      )}
    >
      <label htmlFor="composer" className="sr-only">
        Message the agent
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={2}
        value={text}
        autoFocus={autoFocus}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={
          disabled ? (disabledReason ?? "Not connected") : (placeholder ?? (working ? "Add to the conversation…" : "Ask the agent to build anything…"))
        }
        className="block max-h-[260px] min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">{tools}</div>
        {working && onInterrupt && (
          <Tip
            label={
              <>
                Stop the agent <span className="font-normal opacity-75">Esc</span>
              </>
            }
          >
            <button
              type="button"
              onClick={onInterrupt}
              aria-label="Stop the agent"
              className="inline-flex size-[34px] items-center justify-center rounded-full border border-line-strong bg-paper text-ink hover:bg-cream"
            >
              <Square aria-hidden="true" className="size-3 fill-current" />
            </button>
          </Tip>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send message"
          title="Send (Enter)"
          className={cx(
            "inline-flex size-[34px] shrink-0 items-center justify-center rounded-full transition-colors duration-150",
            canSend ? "bg-lime text-ink hover:bg-[#b2ec52]" : "bg-cream-deep text-ink-faint",
          )}
        >
          <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
});

/** A quiet pill in the composer toolbar or under it: icon, label, chevron. */
export const PickerButton = forwardRef<
  HTMLButtonElement,
  { icon?: ReactNode; children: ReactNode; chevron?: boolean; tone?: "plain" | "muted" } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function PickerButton({ icon, children, chevron = true, tone = "plain", className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cx(
        "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors duration-100 hover:bg-cream-deep data-[popup-open]:bg-cream-deep [&_svg]:size-4 [&_svg]:shrink-0",
        tone === "muted" ? "text-ink-soft" : "text-ink",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {chevron && (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="!size-3.5 text-ink-faint">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
});
