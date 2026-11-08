import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { HlNode } from "./highlightGrammars.ts";

/**
 * Lazy syntax highlighting for code blocks. The highlighter and its grammars load the
 * first time a code block with a known language shows; until then (and for languages it
 * doesn't know) the code shows plain.
 */

type Highlighter = typeof import("./highlightGrammars.ts");
let loading: Promise<Highlighter> | null = null;
let loaded: Highlighter | null = null;

function load(): Promise<Highlighter> {
  loading ??= import("./highlightGrammars.ts").then(m => (loaded = m));
  return loading;
}

function render(nodes: HlNode[], key = "h"): ReactNode[] {
  return nodes.map((n, i) =>
    n.type === "text" ? (
      n.value
    ) : (
      <span key={`${key}-${i}`} className={n.className.join(" ")}>
        {render(n.children, `${key}-${i}`)}
      </span>
    ),
  );
}

/** Highlighted React nodes for `code`, or null while loading or for an unknown language. */
export function useHighlighted(code: string, lang: string): ReactNode[] | null {
  const [ready, setReady] = useState(Boolean(loaded));
  useEffect(() => {
    if (!lang || loaded) return;
    let live = true;
    void load().then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [lang]);
  return useMemo(() => {
    if (!lang || !ready || !loaded) return null;
    const nodes = loaded.highlightCode(code, lang);
    return nodes ? render(nodes) : null;
  }, [code, lang, ready]);
}
