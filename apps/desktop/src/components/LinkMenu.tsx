import type { ReactElement } from "react";
import { Copy, ExternalLink, Globe } from "lucide-react";
import { panelAddress } from "../lib/browser.ts";
import { OPEN_IN_PANEL_EVENT } from "./AgentMessage.tsx";
import { ContextMenu, MenuItem, MenuSeparator } from "./primitives.tsx";
import { toast } from "./Toaster.tsx";
import { openExternal } from "./ui.tsx";

/**
 * The right-click menu on a web link in a thread: open it in the browser, beside the
 * thread when it's a page on this computer (the only pages the side panel shows), or copy
 * its address.
 */
export const linkMenu = (url: string, link: ReactElement) => (
  <ContextMenu
    menu={
      <>
        <MenuItem icon={<ExternalLink aria-hidden="true" />} onSelect={() => void openExternal(url)}>
          Open in your browser
        </MenuItem>
        {panelAddress(url) !== null && (
          <MenuItem icon={<Globe aria-hidden="true" />} onSelect={() => window.dispatchEvent(new CustomEvent<string>(OPEN_IN_PANEL_EVENT, { detail: url }))}>
            Open beside the thread
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Copy aria-hidden="true" />}
          onSelect={() => {
            void navigator.clipboard
              ?.writeText(url)
              .then(() => toast({ title: "Link copied", timeout: 2000 }))
              .catch(() => toast({ title: "Couldn't copy the link", tone: "error" }));
          }}
        >
          Copy link
        </MenuItem>
      </>
    }
  >
    {link}
  </ContextMenu>
);
