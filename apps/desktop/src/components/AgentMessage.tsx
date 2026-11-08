import type { ReactNode } from "react";
import { GitFork } from "lucide-react";
import { CopyButton, StreamingMarkdown } from "../lib/markdown.tsx";
import { loadUiPrefs } from "../lib/storage.ts";
import { LogoMark, cx, openExternal } from "./ui.tsx";

/** Asks the app to show a link in the side panel's browser (`detail` is the URL). */
export const OPEN_IN_PANEL_EVENT = "lemonlime:open-in-panel";

/** Links open in the system browser, or in the side panel when Settings says so. */
const openLink = (url: string) => {
  if (loadUiPrefs().openLinksInPanel) window.dispatchEvent(new CustomEvent<string>(OPEN_IN_PANEL_EVENT, { detail: url }));
  else void openExternal(url);
};

/**
 * One reply from the agent, drawn as Markdown with highlighted code. While it streams only
 * its last block is redrawn. Marked `data-agent-message` (with its timeline key) so
 * selecting text in it offers "Quote" and "Fork from here"; the buttons under it copy the
 * Markdown as written or fork the conversation from this reply.
 */
export function AgentMessage({
  text,
  streaming,
  messageKey,
  onFork,
}: {
  text: string;
  streaming: boolean;
  messageKey?: string;
  onFork?: (() => void) | undefined;
}) {
  return (
    <div className="group/msg flex gap-3">
      <div className="mt-0.5">
        <LogoMark size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <div data-agent-message data-message-key={messageKey} className="text-[15px] leading-relaxed text-ink">
          <StreamingMarkdown text={text} onLink={openLink} />
          {streaming && <span aria-hidden="true" className="mt-1 inline-block h-4 w-[3px] animate-pulse-soft rounded-sm bg-leaf" />}
        </div>
        {!streaming && (
          <MessageActions className="mt-1 -ml-1.5">
            <CopyButton text={text} label="Copy message" showLabel className={ACTION} />
            {onFork && (
              <ActionButton label="Fork into a new thread" icon={<GitFork aria-hidden="true" className="size-3.5" />} onClick={onFork}>
                Fork
              </ActionButton>
            )}
          </MessageActions>
        )}
      </div>
    </div>
  );
}

/** The look of every button under a message. */
export const ACTION = "border-transparent bg-transparent hover:bg-cream-deep";

/**
 * The buttons under a message: hidden until the message is hovered or one of them has
 * the keyboard, so Tab still reaches them. Skipped by find in thread.
 */
export function MessageActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-find-skip
      className={cx(
        "flex h-7 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ActionButton({ label, icon, onClick, children }: { label: string; icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-ink-soft hover:bg-cream-deep hover:text-ink"
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}
