import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, ExternalLink, FileSearch, Globe, RotateCw, Search, SquareTerminal, X } from "lucide-react";
import {
  canGoBack,
  canGoForward,
  currentAddress,
  forgetAddresses,
  goBack,
  goForward,
  loadRecentAddresses,
  normalizeUrl,
  panelAddress,
  rememberAddress,
  shortAddress,
  startHistory,
  visit,
} from "../lib/browser.ts";
import { Kbd, Tip } from "./primitives.tsx";
import { Button, ICON_BUTTON, cx, openExternal, rowFill } from "./ui.tsx";
import { composing } from "../lib/ime.ts";

/**
 * The browser in the side panels: Back, Forward and Reload, an address field, find in page
 * (⌘F while the browser has focus) and a new-tab page with recent addresses.
 */

const FIELD = "h-7 min-w-0 flex-1 rounded-lg border border-control bg-paper px-2 font-mono text-[13px] text-ink placeholder:text-ink-faint disabled:opacity-50";

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tip label={label} side="bottom">
      <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className={ICON_BUTTON}>
        {children}
      </button>
    </Tip>
  );
}

const isFind = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";

export function BrowserView({
  url,
  toAddress = normalizeUrl,
  fromAddress = u => u,
  prefix,
  remember = true,
  onAddress,
  title,
}: {
  /** Where it starts. Later changes are ignored: give the view a new key to start again. */
  url: string;
  /** What was typed, as an address to open (null if it isn't one). */
  toAddress?: (typed: string) => string | null;
  /** What the address field shows for an address. */
  fromAddress?: (url: string) => string;
  /** Shown before the field, e.g. the fixed part of the address. */
  prefix?: ReactNode;
  /** Keep the addresses opened here in the recent list. */
  remember?: boolean;
  onAddress?: (url: string) => void;
  title: string;
}) {
  const [history, setHistory] = useState(() => startHistory(panelAddress(url) ?? url));
  const [load, setLoad] = useState(() => ({ src: panelAddress(url) ?? url, n: 0 }));
  const here = currentAddress(history);
  // Only pages from this computer can be shown here. Anything else opens in the person's own browser.
  const shown = panelAddress(load.src);
  const [outside, setOutside] = useState<string | null>(null);
  const [typed, setTyped] = useState(() => fromAddress(url));
  const [find, setFind] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const announce = useRef(onAddress);
  announce.current = onAddress;

  useEffect(() => {
    setTyped(fromAddress(here));
    announce.current?.(here);
    if (remember) rememberAddress(here);
    // fromAddress is a display helper; the address is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, remember]);

  const open = (next: typeof history) => {
    setHistory(next);
    setLoad(l => ({ src: currentAddress(next), n: l.n + 1 }));
  };
  const reload = () => setLoad(l => ({ src: here, n: l.n + 1 }));

  // A page from the same place as the app can be followed as it moves to other pages.
  const onLoad = () => {
    try {
      const href = frame.current?.contentWindow?.location.href;
      if (href && /^https?:/i.test(href) && href !== here) setHistory(h => visit(h, href));
    } catch {
      /* another address: its location can't be read */
    }
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- catches ⌘F from the controls inside
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={e => {
        if (!isFind(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setFind(n => (n ?? 0) + 1);
      }}
    >
      <form
        onSubmit={e => {
          e.preventDefault();
          const typedAddress = toAddress(typed);
          if (!typedAddress) return;
          const next = panelAddress(typedAddress);
          if (!next) {
            void openExternal(typedAddress);
            setOutside(typedAddress);
            setTyped(fromAddress(here));
            return;
          }
          setOutside(null);
          if (next === here) reload();
          else open(visit(history, next));
        }}
        className="flex items-center gap-0.5 border-b border-line px-2 py-1.5"
      >
        <ToolButton label="Back" disabled={!canGoBack(history)} onClick={() => open(goBack(history))}>
          <ArrowLeft aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Forward" disabled={!canGoForward(history)} onClick={() => open(goForward(history))}>
          <ArrowRight aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Reload" onClick={reload}>
          <RotateCw aria-hidden="true" />
        </ToolButton>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
          {prefix}
          <input
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onFocus={e => e.target.select()}
            aria-label="Address"
            spellCheck={false}
            className={FIELD}
          />
        </span>
        <ToolButton label="Find in page" onClick={() => setFind(n => (n ?? 0) + 1)}>
          <Search aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Open in your browser" onClick={() => void openExternal(here)}>
          <ExternalLink aria-hidden="true" />
        </ToolButton>
      </form>
      {find !== null && <FindInPage frame={frame} address={here} nonce={find} onClose={() => setFind(null)} onOpenOutside={() => void openExternal(here)} />}
      {outside && (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-cream-deep/60 px-3 py-2 text-[13px] text-ink-soft">
          <span className="min-w-0 flex-1 text-pretty">Opened {shortAddress(outside)} in your browser. Only pages from this computer can be shown here.</span>
          <button type="button" aria-label="Dismiss" className={ICON_BUTTON} onClick={() => setOutside(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
      {shown ? (
        <iframe
          key={load.n}
          ref={frame}
          title={title}
          src={shown}
          onLoad={onLoad}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          className="min-h-0 w-full flex-1 bg-paper"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-[340px] text-[14px] text-pretty text-ink-soft">
            Only pages from this computer, like localhost:3000, can be shown here. {shortAddress(load.src)} opens in your browser.
          </p>
          <Button onClick={() => void openExternal(load.src)}>
            <ExternalLink aria-hidden="true" className="size-4" />
            Open in your browser
          </Button>
        </div>
      )}
    </div>
  );
}

type FrameFind = Window & { find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrap?: boolean) => boolean };

/** How often `query` appears in `text`, ignoring case. */
export function countMatches(text: string, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let n = 0;
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) n++;
  return n;
}

/** Whether a page at `address` can be searched from this window (it has the same origin). */
export function sameOrigin(address: string, here: string): boolean {
  try {
    return new URL(address).origin === new URL(here).origin;
  } catch {
    return false;
  }
}

function FindInPage({
  frame,
  address,
  nonce,
  onClose,
  onOpenOutside,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  address: string;
  nonce: number;
  onClose: () => void;
  onOpenOutside: () => void;
}) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [missed, setMissed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // A page from another address can't be searched from outside it.
  const doc = (): Document | null => {
    try {
      return frame.current?.contentDocument ?? null;
    } catch {
      return null;
    }
  };
  const searchable = sameOrigin(address, window.location.href);

  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [nonce]);

  const step = (backwards: boolean) => {
    const win = frame.current?.contentWindow as FrameFind | null | undefined;
    if (!query || !win?.find) return;
    setMissed(!win.find(query, false, backwards, true));
  };
  useEffect(() => {
    const d = doc();
    setCount(d && query ? countMatches(d.body?.innerText ?? "", query) : null);
    setMissed(false);
    if (query) {
      const win = frame.current?.contentWindow as FrameFind | null | undefined;
      try {
        win?.getSelection()?.removeAllRanges();
        if (win?.find) setMissed(!win.find(query, false, false, true));
      } catch {
        /* nothing to search */
      }
    }
    // Searching again only when the words change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (!searchable) {
    return (
      <div role="status" className="flex items-center gap-2 border-b border-line bg-cream-deep/60 px-3 py-2 text-[13px] text-ink-soft">
        <span className="min-w-0 flex-1 text-pretty">This page comes from another address, so it can't be searched from here. Its own browser can.</span>
        <Button size="sm" variant="ghost" onClick={onOpenOutside}>
          Open in your browser
        </Button>
        <button type="button" aria-label="Close" className={ICON_BUTTON} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div role="search" className="flex items-center gap-1 border-b border-line px-2 py-1.5">
      <input
        ref={input}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (composing(e)) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey);
          }
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        className={cx(FIELD, "font-sans text-[13px]")}
      />
      <span aria-live="polite" className="min-w-16 px-1 text-right text-[13px] text-ink-faint tabular-nums">
        {query ? (count === 0 || missed ? "No matches" : count === 1 ? "1 match" : `${count} matches`) : ""}
      </span>
      <button type="button" aria-label="Previous match (Shift Enter)" disabled={!count} className={ICON_BUTTON} onClick={() => step(true)}>
        <ChevronUp aria-hidden="true" />
      </button>
      <button type="button" aria-label="Next match (Enter)" disabled={!count} className={ICON_BUTTON} onClick={() => step(false)}>
        <ChevronDown aria-hidden="true" />
      </button>
      <button type="button" aria-label="Close (Esc)" className={ICON_BUTTON} onClick={onClose}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

/** A blank tab: open an address (a recent one, or typed), a file in the project, or a terminal. */
export function NewTabPage({
  onBrowser,
  onTerminal,
  onFindFile,
  findFileKeys,
  heading = "Open in this panel",
  placeholder = "localhost:3000",
}: {
  onBrowser: (url: string) => void;
  onTerminal?: (() => void) | undefined;
  /** Opens the project's file search. */
  onFindFile?: (() => void) | undefined;
  /** Key caps for the file search shortcut, if it has one. */
  findFileKeys?: string[] | undefined;
  heading?: string;
  placeholder?: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const [recents, setRecents] = useState(loadRecentAddresses);
  const recentsId = useId();
  // Only pages from this computer can be shown here. Anything else opens in the person's own browser.
  const [outside, setOutside] = useState<string | null>(null);
  const go = (address: string) => {
    const here = panelAddress(address);
    if (here) return onBrowser(here);
    void openExternal(address);
    setOutside(address);
  };
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-[380px] flex-col gap-5">
        <p className="text-center text-[15px] font-medium text-balance">{heading}</p>
        <form
          onSubmit={e => {
            e.preventDefault();
            const u = normalizeUrl(url || placeholder);
            setError(!u);
            setOutside(null);
            if (u) go(u);
          }}
          className="flex flex-col gap-1.5"
        >
          <span className="flex gap-2">
            <input
              value={url}
              onChange={e => (setUrl(e.target.value), setError(false), setOutside(null))}
              placeholder={placeholder}
              aria-label="Address to open"
              aria-invalid={error}
              spellCheck={false}
              className={cx(FIELD, "h-9 px-2.5 text-[13px]")}
            />
            <Button type="submit">
              <Globe aria-hidden="true" className="size-4" />
              Open
            </Button>
          </span>
          {error && (
            <span role="alert" className="text-[13px] text-danger">
              That isn't an address. Try something like localhost:3000.
            </span>
          )}
          {outside && (
            <span role="status" className="text-[13px] text-pretty text-ink-soft">
              Opened {shortAddress(outside)} in your browser. Only pages from this computer can be shown here.
            </span>
          )}
        </form>
        {(onFindFile || onTerminal) && (
          <div className="flex flex-col gap-2">
            {onFindFile && (
              <button
                type="button"
                onClick={onFindFile}
                className="flex h-9 items-center gap-2.5 rounded-lg border border-control bg-paper px-2.5 text-left text-[14px] text-ink-soft transition-colors duration-100 hover:bg-cream-deep hover:text-ink"
              >
                <FileSearch aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Find a file in this project</span>
                {findFileKeys?.length ? (
                  <span className="flex gap-0.5">
                    {findFileKeys.map(k => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                ) : null}
              </button>
            )}
            {onTerminal && (
              <Button onClick={onTerminal}>
                <SquareTerminal aria-hidden="true" className="size-4" />
                Start a terminal on this computer
              </Button>
            )}
          </div>
        )}
        {recents.length > 0 && (
          <section aria-labelledby={recentsId}>
            <div className="flex items-baseline justify-between px-1 pb-1">
              <h3 id={recentsId} className="font-sans text-[13px] font-medium tracking-normal text-ink-soft">
                Recent
              </h3>
              <button
                type="button"
                className="text-[13px] text-ink-faint hover:text-ink"
                onClick={() => {
                  forgetAddresses();
                  setRecents([]);
                }}
              >
                Clear
              </button>
            </div>
            <ul className="flex flex-col gap-0.5">
              {recents.map(r => (
                <li key={r}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    className={cx(
                      "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14px] text-ink transition-colors duration-100",
                      rowFill(false),
                    )}
                  >
                    <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{shortAddress(r)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-center text-[13px] text-pretty text-ink-faint">
          Pages from this computer, like localhost:3000, open here. Other addresses open in your browser.
        </p>
      </div>
    </div>
  );
}
