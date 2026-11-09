import { useEffect, useState } from "react";
import { freshAnnouncements } from "../lib/announce.ts";

/**
 * The app's one polite live region, outside the sidebar, for news a screen reader should
 * hear without moving focus. Lines that arrive together are said together.
 */
let say: ((line: string) => void) | null = null;

export function announce(line: string): void {
  say?.(line);
}

export function LiveAnnouncer() {
  const [text, setText] = useState("");
  useEffect(() => {
    const said = new Map<string, number>();
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let clear: ReturnType<typeof setTimeout> | undefined;
    say = line => {
      pending.push(line);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const lines = freshAnnouncements(pending, said, Date.now());
        pending = [];
        if (!lines.length) return;
        setText(lines.join(" "));
        // Emptied again after a while, so the same words can be said later.
        clearTimeout(clear);
        clear = setTimeout(() => setText(""), 5000);
      }, 200);
    };
    return () => {
      say = null;
      clearTimeout(timer);
      clearTimeout(clear);
    };
  }, []);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
