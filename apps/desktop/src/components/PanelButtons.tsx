import { createContext, useContext, type ReactNode } from "react";
import { Folder, Globe, Terminal } from "lucide-react";
import { Tip } from "./primitives.tsx";
import { cx } from "./ui.tsx";

export interface PanelButton {
  /** True while the panel shows this kind of tab. */
  on: boolean;
  onClick: () => void;
}

const BUTTON = "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink [&_svg]:size-4";

/** The terminal, browser and files buttons at the top right of a page: each opens the side panel on that tab, or hides it. */
export function PanelButtons({ terminal, browser, files }: { terminal: PanelButton | null; browser: PanelButton; files?: PanelButton }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {terminal && (
        <Tip label={terminal.on ? "Hide terminal" : "Terminal"} side="bottom">
          <button
            type="button"
            aria-label="Terminal"
            aria-pressed={terminal.on}
            onClick={terminal.onClick}
            className={cx(BUTTON, terminal.on && "bg-cream-deep text-ink")}
          >
            <Terminal aria-hidden="true" />
          </button>
        </Tip>
      )}
      <Tip label={browser.on ? "Hide browser" : "Browser"} side="bottom">
        <button
          type="button"
          aria-label="Browser"
          aria-pressed={browser.on}
          onClick={browser.onClick}
          className={cx(BUTTON, browser.on && "bg-cream-deep text-ink")}
        >
          <Globe aria-hidden="true" />
        </button>
      </Tip>
      {files && (
        <Tip label={files.on ? "Hide files" : "Files"} side="bottom">
          <button type="button" aria-label="Files" aria-pressed={files.on} onClick={files.onClick} className={cx(BUTTON, files.on && "bg-cream-deep text-ink")}>
            <Folder aria-hidden="true" />
          </button>
        </Tip>
      )}
    </div>
  );
}

const Tools = createContext<ReactNode>(null);

/** The app hands every page its panel buttons through this, so each header can place them. */
export const PageToolsProvider = Tools.Provider;

/** Where a page's header shows the panel buttons. */
export function PageTools() {
  return <>{useContext(Tools)}</>;
}
