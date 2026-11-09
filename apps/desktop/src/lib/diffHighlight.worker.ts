import { highlightCode } from "./highlightGrammars.ts";
import { splitHighlightedLines } from "./diffView.ts";

/** Highlights both sides of a file's diff off the main thread (see diffHighlighter.ts). */
self.onmessage = (e: MessageEvent<{ id: number; old: string; new: string; lang: string }>) => {
  const { id, lang } = e.data;
  const side = (text: string) => {
    try {
      const nodes = highlightCode(text, lang);
      return nodes ? splitHighlightedLines(nodes) : null;
    } catch {
      return null;
    }
  };
  self.postMessage({ id, old: side(e.data.old), new: side(e.data.new) });
};
