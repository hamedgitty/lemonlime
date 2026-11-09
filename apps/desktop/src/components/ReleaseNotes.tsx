import { Markdown } from "../lib/markdown.tsx";
import { Popover } from "./primitives.tsx";
import { Button, openExternal } from "./ui.tsx";

/** "What's new" beside the update banner: the release's own notes, in a popover. */
export function ReleaseNotes({ version, notes }: { version: string; notes: string }) {
  return (
    <Popover
      align="end"
      trigger={
        <Button size="sm" variant="ghost">
          What's new
        </Button>
      }
      className="w-[min(420px,calc(100vw-32px))]"
    >
      <div className="border-b border-line px-4 py-3">
        <p className="text-[14px] font-semibold text-ink">What's new in {version}</p>
      </div>
      <div className="scroll-thin max-h-[min(420px,60vh)] overflow-y-auto px-4 py-3 text-[14px] text-ink">
        <Markdown text={notes} onLink={url => void openExternal(url)} />
      </div>
    </Popover>
  );
}
