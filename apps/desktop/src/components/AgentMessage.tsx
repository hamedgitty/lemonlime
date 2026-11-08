import { CopyButton, StreamingMarkdown } from "../lib/markdown.tsx";
import { loadUiPrefs } from "../lib/storage.ts";
import { LogoMark, openExternal } from "./ui.tsx";

/** Asks the app to show a link in the side panel's browser (`detail` is the URL). */
export const OPEN_IN_PANEL_EVENT = "lemonlime:open-in-panel";

/** Links open in the system browser, or in the side panel when Settings says so. */
const openLink = (url: string) => {
  if (loadUiPrefs().openLinksInPanel) window.dispatchEvent(new CustomEvent<string>(OPEN_IN_PANEL_EVENT, { detail: url }));
  else void openExternal(url);
};

/**
 * One reply from the agent, drawn as Markdown with highlighted code. While it streams only
 * its last block is redrawn. Marked `data-agent-message` so selecting text in it offers
 * "Quote"; the Copy button under it copies the Markdown as written.
 */
export function AgentMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="group/agent flex gap-3">
      <div className="mt-0.5">
        <LogoMark size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <div data-agent-message className="text-[14.5px] leading-relaxed text-ink">
          <StreamingMarkdown text={text} onLink={openLink} />
          {streaming && <span aria-hidden="true" className="mt-1 inline-block h-4 w-[3px] animate-pulse-soft rounded-sm bg-leaf" />}
        </div>
        {!streaming && (
          <div className="mt-1 -ml-1.5 flex h-7 opacity-0 transition-opacity duration-150 group-hover/agent:opacity-100 focus-within:opacity-100">
            <CopyButton text={text} label="Copy message" showLabel className="border-transparent bg-transparent hover:bg-ink/5" />
          </div>
        )}
      </div>
    </div>
  );
}
