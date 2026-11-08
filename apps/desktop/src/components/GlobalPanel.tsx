import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ExternalLink, Globe, Maximize2, Minimize2, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { inDesktopShell } from "../lib/native.ts";
import { Tip } from "./primitives.tsx";
import { Button, cx, openExternal } from "./ui.tsx";

export type PanelTab =
  { id: string; kind: "terminal"; title: string } | { id: string; kind: "browser"; title: string; url: string } | { id: string; kind: "new"; title: string };

const TERM_THEME = {
  background: "#11190a",
  foreground: "#dfe6d3",
  cursor: "#a3e635",
  cursorAccent: "#11190a",
  selectionBackground: "#3f7a1680",
  black: "#1b2612",
  red: "#f07a6a",
  green: "#a3e635",
  yellow: "#ffe135",
  blue: "#8cb8ff",
  magenta: "#d7a6ff",
  cyan: "#7fd6c2",
  white: "#dfe6d3",
  brightBlack: "#9aa58d",
  brightWhite: "#ffffff",
};

/**
 * The side panel on every page: tabs of terminals on this computer and a browser, added with
 * "+". Tabs live as long as the app, so switching pages never kills a shell.
 */
export function GlobalPanel({
  tabs,
  active,
  onTabs,
  onActive,
  side,
  onSide,
  onClose,
  hidden,
}: {
  tabs: PanelTab[];
  active: string | null;
  onTabs: (t: PanelTab[]) => void;
  onActive: (id: string) => void;
  side: "left" | "right";
  onSide: (s: "left" | "right") => void;
  onClose: () => void;
  /** Kept mounted (shells keep running) but out of sight. */
  hidden: boolean;
}) {
  const [full, setFull] = useState(false);
  const add = () => {
    const id = crypto.randomUUID();
    onTabs([...tabs, { id, kind: "new", title: "New tab" }]);
    onActive(id);
  };
  const replace = (id: string, next: PanelTab) => onTabs(tabs.map(t => (t.id === id ? next : t)));
  const close = (id: string) => {
    const rest = tabs.filter(t => t.id !== id);
    onTabs(rest);
    if (active === id && rest.length) onActive(rest[rest.length - 1]!.id);
    if (!rest.length) onClose();
  };
  const current = tabs.find(t => t.id === active) ?? tabs[0];

  return (
    <aside
      aria-label="Side panel"
      hidden={hidden}
      className={cx(
        "flex shrink-0 flex-col bg-cream",
        full ? "absolute inset-0 z-30" : "w-[clamp(300px,42%,460px)]",
        !full && (side === "right" ? "order-last border-l border-line" : "order-first border-r border-line"),
      )}
    >
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-2">
        <div role="tablist" aria-label="Panel tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map(t => (
            <div
              key={t.id}
              className={cx(
                "group/tab inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2.5 text-[13px]",
                t.id === current?.id ? "bg-cream-deep text-ink" : "text-ink-soft hover:bg-cream-deep/60",
              )}
            >
              <button type="button" role="tab" aria-selected={t.id === current?.id} onClick={() => onActive(t.id)} className="inline-flex items-center gap-1.5">
                {t.kind === "terminal" ? (
                  <SquareTerminal aria-hidden="true" className="size-3.5" />
                ) : t.kind === "browser" ? (
                  <Globe aria-hidden="true" className="size-3.5" />
                ) : (
                  <Plus aria-hidden="true" className="size-3.5" />
                )}
                <span className="max-w-[120px] truncate">{t.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                onClick={() => close(t.id)}
                className="inline-flex size-5 items-center justify-center rounded text-ink-faint opacity-0 group-hover/tab:opacity-100 hover:text-ink focus-visible:opacity-100"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Tip label="New tab" side="bottom">
          <button type="button" aria-label="New tab" onClick={add} className={ICON}>
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </Tip>
        <Tip label={side === "right" ? "Move to the left" : "Move to the right"} side="bottom">
          <button
            type="button"
            aria-label={side === "right" ? "Move panel to the left" : "Move panel to the right"}
            onClick={() => onSide(side === "right" ? "left" : "right")}
            className={ICON}
          >
            <ArrowLeftRight aria-hidden="true" className="size-4" />
          </button>
        </Tip>
        <Tip label={full ? "Exit full screen" : "Full screen"} side="bottom">
          <button type="button" aria-label={full ? "Exit full screen" : "Full screen"} onClick={() => setFull(f => !f)} className={ICON}>
            {full ? <Minimize2 aria-hidden="true" className="size-4" /> : <Maximize2 aria-hidden="true" className="size-4" />}
          </button>
        </Tip>
        <Tip label="Close panel" side="bottom">
          <button type="button" aria-label="Close panel" onClick={onClose} className={ICON}>
            <X aria-hidden="true" className="size-4" />
          </button>
        </Tip>
      </div>
      {tabs.map(t => (
        <div key={t.id} className={cx("min-h-0 flex-1 flex-col", t.id === current?.id ? "flex" : "hidden")}>
          {t.kind === "new" && (
            <NewTab
              onTerminal={() => replace(t.id, { id: t.id, kind: "terminal", title: "Terminal" })}
              onBrowser={url => replace(t.id, { id: t.id, kind: "browser", title: hostOf(url), url })}
            />
          )}
          {t.kind === "terminal" && <HostTerminal onTitle={title => replace(t.id, { ...t, title })} visible={!hidden && t.id === current?.id} />}
          {t.kind === "browser" && <Browser url={t.url} onUrl={url => replace(t.id, { ...t, url, title: hostOf(url) })} />}
        </div>
      ))}
    </aside>
  );
}

const ICON = "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink";

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Makes "localhost:3000" or "example.com" into a full address. */
export function normalizeUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v) ? `http://${v}` : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function NewTab({ onTerminal, onBrowser }: { onTerminal: () => void; onBrowser: (url: string) => void }) {
  const [url, setUrl] = useState("localhost:3000");
  const [error, setError] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-[15px] font-medium">Open in this panel</p>
      <div className="flex w-full max-w-[320px] flex-col gap-3">
        <Button onClick={onTerminal} disabled={!inDesktopShell()}>
          <SquareTerminal aria-hidden="true" className="size-4" />
          Start a terminal on this computer
        </Button>
        <form
          onSubmit={e => {
            e.preventDefault();
            const u = normalizeUrl(url);
            setError(!u);
            if (u) onBrowser(u);
          }}
          className="flex gap-2"
        >
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            aria-label="Address to open"
            aria-invalid={error}
            spellCheck={false}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-paper px-2.5 font-mono text-[13px] outline-none focus:border-leaf"
          />
          <Button type="submit">
            <Globe aria-hidden="true" className="size-4" />
            Open
          </Button>
        </form>
        <p className="text-[12.5px] text-ink-faint">Local dev servers work best; many websites refuse to be shown inside another app.</p>
      </div>
    </div>
  );
}

function Browser({ url, onUrl }: { url: string; onUrl: (url: string) => void }) {
  const [typed, setTyped] = useState(url);
  const [reload, setReload] = useState(0);
  useEffect(() => setTyped(url), [url]);
  return (
    <>
      <form
        onSubmit={e => {
          e.preventDefault();
          const u = normalizeUrl(typed);
          if (u) onUrl(u);
          setReload(r => r + 1);
        }}
        className="flex items-center gap-1 border-b border-line px-2 py-1.5"
      >
        <button type="button" aria-label="Reload" onClick={() => setReload(r => r + 1)} className={ICON}>
          <RotateCw aria-hidden="true" className="size-4" />
        </button>
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          aria-label="Address"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-paper px-2 font-mono text-[12.5px] outline-none focus:border-leaf"
        />
        <button type="button" aria-label="Open in your browser" onClick={() => void openExternal(url)} className={ICON}>
          <ExternalLink aria-hidden="true" className="size-4" />
        </button>
      </form>
      <iframe
        key={`${url}#${reload}`}
        title={hostOf(url)}
        src={url}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
        className="min-h-0 w-full flex-1 bg-paper"
      />
    </>
  );
}

type HostOutput = { id: number; data: string | null; exited: boolean };

/** A shell on this computer (not tied to any thread), in your home folder. */
function HostTerminal({ onTitle, visible }: { onTitle: (t: string) => void; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const titled = useRef(onTitle);
  titled.current = onTitle;

  useEffect(() => {
    if (!host.current || !inDesktopShell()) return;
    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    termRef.current = { term, fit };
    let id: number | null = null;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    setExited(false);
    setError(null);
    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
      const off = await listen<HostOutput>("host-terminal", e => {
        if (e.payload.id !== id) return;
        if (e.payload.data) term.write(e.payload.data);
        if (e.payload.exited) setExited(true);
      });
      cleanups.push(off);
      try {
        const opened = await invoke<{ id: number; shell: string }>("host_terminal_open", { cols: term.cols, rows: term.rows, cwd: null });
        if (disposed) return void invoke("host_terminal_close", { id: opened.id });
        id = opened.id;
        titled.current(opened.shell);
        const input = term.onData(d => void invoke("host_terminal_write", { id, data: d }).catch(() => undefined));
        const resize = term.onResize(({ cols, rows }) => void invoke("host_terminal_resize", { id, cols, rows }).catch(() => undefined));
        cleanups.push(
          () => input.dispose(),
          () => resize.dispose(),
          () => void invoke("host_terminal_close", { id }),
        );
        term.focus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    observer.observe(host.current);
    return () => {
      disposed = true;
      observer.disconnect();
      for (const c of cleanups) c();
      term.dispose();
      termRef.current = null;
    };
  }, [generation]);

  // Fit again when the tab comes back into view.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => termRef.current?.fit.fit());
  }, [visible]);

  if (!inDesktopShell()) return <p className="m-3 text-[14px] text-ink-soft">Terminals on this computer work in the desktop app.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-rind">
      {(exited || error) && (
        <div role="status" className="flex items-center gap-3 border-b border-rind-line px-3 py-2 text-[13px] text-rind-muted">
          <span className="flex-1">{error ?? "The shell has exited."}</span>
          <Button size="sm" onClick={() => setGeneration(g => g + 1)}>
            New shell
          </Button>
        </div>
      )}
      <div ref={host} aria-label="Terminal" className="min-h-0 flex-1 px-2 py-1.5" />
    </div>
  );
}
