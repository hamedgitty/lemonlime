/**
 * Find in thread (⌘F): every place the query appears in the timeline's text, as DOM
 * ranges, drawn with the CSS Custom Highlight API so React's DOM is never touched.
 */

/** Where `query` appears in `text`, ignoring case. Matches don't overlap. */
export function findOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The next (or previous) match, wrapping round at either end. -1 when there are none. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

/** "3 of 12", "No results", or nothing before anything is typed. */
export function matchLabel(current: number, total: number, query: string): string {
  if (!query) return "";
  if (total === 0) return "No results";
  return `${current + 1} of ${total}`;
}

/** Ranges for every match inside `root`, in document order. Skips elements marked `data-find-skip`. */
export function findRanges(root: HTMLElement, query: string, limit = 2000): Range[] {
  if (!query) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest("[data-find-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node && ranges.length < limit; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    for (const at of findOffsets(text, query)) {
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + query.length);
      ranges.push(r);
      if (ranges.length >= limit) break;
    }
  }
  return ranges;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null =>
  typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: HighlightRegistry }).highlights : null;
const HighlightCtor = (): (new (...ranges: Range[]) => unknown) | null =>
  typeof globalThis !== "undefined" && "Highlight" in globalThis ? (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight : null;

/** Paints all matches and the current one (styled in styles.css as ::highlight(find-…)). */
export function paintMatches(ranges: readonly Range[], current: number): void {
  const reg = registry();
  const H = HighlightCtor();
  if (!reg || !H) return;
  reg.set("find-match", new H(...ranges.filter((_, i) => i !== current)));
  if (ranges[current]) reg.set("find-current", new H(ranges[current]));
  else reg.delete("find-current");
}

export function clearMatches(): void {
  const reg = registry();
  reg?.delete("find-match");
  reg?.delete("find-current");
}

/** Scrolls `scroller` so the range sits in the middle third, if it isn't visible already. */
export function revealRange(range: Range, scroller: HTMLElement): void {
  const box = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.height === 0 && box.width === 0) {
    range.startContainer.parentElement?.scrollIntoView({ block: "center" });
    return;
  }
  if (box.top >= view.top + 40 && box.bottom <= view.bottom - 40) return;
  scroller.scrollTop += box.top - view.top - view.height / 3;
}
