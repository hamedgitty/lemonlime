import { createContext, useContext, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { KEYS, LIST_COLUMN, useFolded, useSideWidth } from "../lib/sideWidth.ts";
import { SideResizer } from "./SideResizer.tsx";
import { IconButton } from "./ui.tsx";

const Fold = createContext<(() => void) | null>(null);

/**
 * The list on the left of the Skills and Plugins pages. It can be resized by its edge and
 * folded down to a slim strip, so the details beside it get the whole width. The width and
 * whether it's folded are shared by every such list and remembered on this computer.
 */
export function ListColumn({ label, as: Tag = "section", children }: { label: string; as?: "section" | "aside"; children: ReactNode }) {
  const [folded, setFolded] = useFolded(KEYS.listFolded);
  const [width, setWidth] = useSideWidth(KEYS.listColumn, LIST_COLUMN);
  if (folded)
    return (
      <Tag aria-label={label} className="flex w-12 shrink-0 flex-col items-center border-r border-line pt-3">
        <IconButton label="Show the list" onClick={() => setFolded(false)}>
          <PanelLeftOpen aria-hidden="true" />
        </IconButton>
      </Tag>
    );
  return (
    <Tag aria-label={label} className="relative flex shrink-0 flex-col border-r border-line" style={{ width, maxWidth: "60%" }}>
      <Fold.Provider value={() => setFolded(true)}>{children}</Fold.Provider>
      <SideResizer edge="right" width={width} bounds={LIST_COLUMN} label="Resize the list" onWidth={setWidth} onFold={() => setFolded(true)} />
    </Tag>
  );
}

/** The button in a list's header that folds the list away. */
export function HideListButton() {
  const fold = useContext(Fold);
  if (!fold) return null;
  return (
    <IconButton label="Hide the list" onClick={fold}>
      <PanelLeftClose aria-hidden="true" />
    </IconButton>
  );
}
