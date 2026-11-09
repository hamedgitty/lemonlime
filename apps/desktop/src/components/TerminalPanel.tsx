import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { runnerHttpBase, TerminalClient, terminalUrl, type TerminalState } from "@lemonlime/client";
import { findTerminalTargets, projectPathCandidate } from "../lib/terminalTargets.ts";
import { quoteTerminal } from "../lib/review.ts";
import { QUOTE_ITEM, QuoteToolbar } from "./SelectionQuote.tsx";
import { Button } from "./ui.tsx";

/** The rind tones: terminals are the one dark surface in the app. */
const THEME = {
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
  brightRed: "#ff9c8f",
  brightGreen: "#c4f27a",
  brightYellow: "#fff07a",
  brightBlue: "#b0cfff",
  brightMagenta: "#e6c6ff",
  brightCyan: "#a6eadb",
  brightWhite: "#ffffff",
};

const LABELS: Record<TerminalState, string> = {
  connecting: "Connecting…",
  live: "",
  reconnecting: "Reconnecting…",
  exited: "The shell has exited.",
  unavailable: "No terminal here.",
  closed: "This terminal was closed.",
};

/**
 * A shell in the thread's own folder (its branch), on the computer or sandbox where the
 * agent runs. It keeps running when the panel closes; reopening picks up where it was.
 * A thread can have several, each with its own `terminal` id.
 */
export function TerminalPanel({
  connection,
  terminal,
  active = true,
  onName,
  onTitle,
  onAddToChat,
  onOpenUrl,
  onOpenFile,
  script,
  run = 0,
  onRun,
}: {
  connection: { url: string; token: () => Promise<string> } | null;
  /** Which of the thread's terminals (the runner's default when left out). */
  terminal?: string;
  /** On screen: takes the keyboard when it becomes active. */
  active?: boolean;
  /** The shell's name, e.g. "zsh". */
  onName?: (name: string) => void;
  /** The title the shell set (often its current folder). */
  onTitle?: (title: string) => void;
  /** Put picked text into the message being written. */
  onAddToChat?: (text: string) => void;
  /** A web address in the output was clicked. */
  onOpenUrl?: (url: string) => void;
  /** A `path:line` in the output that is a file in the project was clicked. */
  onOpenFile?: (path: string, line: number) => void;
  /** This terminal runs one of the project's scripts (by id) instead of a shell. */
  script?: string | undefined;
  /** Bumped each time the user asks to run the script: it runs unless it's running already. */
  run?: number;
  /** The script was started (to open its preview). */
  onRun?: () => void;
}) {
  const termRef = useRef<Terminal | null>(null);
  const names = useRef({ onName, onTitle, onOpenUrl, onOpenFile });
  names.current = { onName, onTitle, onOpenUrl, onOpenFile };
  const [picked, setPicked] = useState<{ text: string; top: number; left: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const [state, setState] = useState<TerminalState>("connecting");
  const [detail, setDetail] = useState<string | undefined>();

  useEffect(() => {
    if (!connection || !host.current) return;
    const term = new Terminal({
      theme: THEME,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    termRef.current = term;
    const title = term.onTitleChange(t => names.current.onTitle?.(t));
    const links = term.registerLinkProvider(linkProvider(term, connection, names));
    // Picked text offers "Add to chat", by the end of the selection.
    const selection = term.onSelectionChange(() => {
      const text = term.hasSelection() ? term.getSelection() : "";
      const at = term.getSelectionPosition();
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      const wrap = host.current?.parentElement;
      if (!text.trim() || !at || !screen || !wrap) return setPicked(null);
      const box = screen.getBoundingClientRect();
      const outer = wrap.getBoundingClientRect();
      const cellW = box.width / term.cols;
      const cellH = box.height / term.rows;
      const row = at.end.y - term.buffer.active.viewportY;
      const top = Math.min(Math.max(row + 1, 1), term.rows) * cellH + box.top - outer.top + 4;
      const left = Math.max(4, Math.min(at.end.x * cellW + box.left - outer.left - 60, outer.width - 124));
      setPicked({ text, top: Math.min(top, outer.height - 40), left });
    });
    const client = new TerminalClient({
      url: terminalUrl(connection.url),
      token: connection.token,
      ...(terminal ? { terminal } : {}),
      ...(script ? { script } : {}),
      onName: n => names.current.onName?.(n),
      cols: term.cols,
      rows: term.rows,
      onData: d => term.write(d),
      onReset: () => term.reset(),
      onState: (s, d) => {
        setState(s);
        setDetail(d);
      },
    });
    clientRef.current = client;
    const input = term.onData(d => client.write(d));
    const resize = term.onResize(({ cols, rows }) => client.resize(cols, rows));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    observer.observe(host.current);
    client.connect();
    term.focus();
    return () => {
      observer.disconnect();
      title.dispose();
      links.dispose();
      selection.dispose();
      setPicked(null);
      termRef.current = null;
      input.dispose();
      resize.dispose();
      client.close();
      clientRef.current = null;
      term.dispose();
    };
  }, [connection, terminal, script]);

  // Run the script when asked: once the runner says it isn't running, start it.
  const handledRun = useRef(0);
  const ran = useRef(onRun);
  ran.current = onRun;
  const startScript = () => {
    clientRef.current?.restart();
    ran.current?.();
  };
  useEffect(() => {
    if (!script || run <= handledRun.current) return;
    if (state === "exited") {
      handledRun.current = run;
      startScript();
    } else if (state === "live") handledRun.current = run;
    // startScript only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, run, state]);

  // Coming back to this tab: refit (it was hidden) and take the keyboard.
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    if (!t) return;
    requestAnimationFrame(() => {
      try {
        t.focus();
      } catch {
        /* disposed */
      }
    });
  }, [active]);

  if (!connection) {
    return (
      <p className="m-2 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
        The terminal opens once the thread is running.
      </p>
    );
  }
  const note =
    script && state === "exited"
      ? detail
        ? "The script finished"
        : "The script isn't running."
      : script && state === "closed"
        ? LABELS.closed
        : LABELS[state];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-rind">
      {note && (
        <div role="status" className="flex items-center gap-3 border-b border-rind-line px-3 py-2 text-[13px] text-rind-muted">
          <span className="flex-1">
            {note}
            {detail ? (script ? ` (${detail}).` : ` ${detail}`) : ""}
          </span>
          {state === "exited" && (
            <Button size="sm" variant="secondary" onClick={() => (script ? startScript() : clientRef.current?.restart())}>
              {script ? (detail ? "Run again" : "Run") : "New shell"}
            </Button>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={host} aria-label="Terminal" className="min-h-0 flex-1 px-2 py-1.5" />
        {picked && onAddToChat && (
          <QuoteToolbar style={{ top: picked.top, left: picked.left }}>
            <button
              type="button"
              className={QUOTE_ITEM}
              onClick={() => {
                const text = quoteTerminal(picked.text);
                if (text) onAddToChat(text);
                termRef.current?.clearSelection();
                setPicked(null);
              }}
            >
              <MessageSquarePlus aria-hidden="true" className="size-3.5" />
              Add to chat
            </button>
          </QuoteToolbar>
        )}
      </div>
    </div>
  );
}

/** Asks the runner once per path whether the terminal's `path:line` is a file in the project. */
function fileChecker(connection: { url: string; token: () => Promise<string> }): (path: string) => Promise<string | null> {
  const known = new Map<string, Promise<string | null>>();
  return path => {
    const asked = projectPathCandidate(path);
    if (!asked) return Promise.resolve(null);
    let found = known.get(asked);
    if (!found) {
      found = (async () => {
        try {
          const res = await fetch(`${runnerHttpBase(connection.url)}/file-exists?path=${encodeURIComponent(asked)}`, {
            headers: { authorization: `Bearer ${await connection.token()}` },
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { path?: unknown };
          return typeof body.path === "string" ? body.path : null;
        } catch {
          return null;
        }
      })();
      // Forget the answer after a while: the file may be made or removed later.
      setTimeout(() => known.delete(asked), 30_000);
      known.set(asked, found);
    }
    return found;
  };
}

/**
 * Web addresses and project `path:line` places in the output, underlined on hover and
 * opened on click. A long line the terminal wrapped is read as one.
 */
function linkProvider(
  term: Terminal,
  connection: { url: string; token: () => Promise<string> },
  handlers: { current: { onOpenUrl?: ((url: string) => void) | undefined; onOpenFile?: ((path: string, line: number) => void) | undefined } },
) {
  const exists = fileChecker(connection);
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const buf = term.buffer.active;
      let first = y - 1;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      let last = y - 1;
      while (buf.getLine(last + 1)?.isWrapped) last++;
      let text = "";
      for (let r = first; r <= last; r++) text += buf.getLine(r)?.translateToString(r === last) ?? "";
      const cols = term.cols;
      const at = (i: number) => ({ x: (i % cols) + 1, y: first + Math.floor(i / cols) + 1 });
      const found = findTerminalTargets(text).filter(l => at(l.start).y <= y && at(l.end - 1).y >= y);
      if (!found.length) return callback(undefined);
      void Promise.all(
        found.map(async (l): Promise<ILink | null> => {
          const range = { start: at(l.start), end: at(l.end - 1) };
          if (l.kind === "url") {
            if (!handlers.current.onOpenUrl) return null;
            return { range, text: l.text, decorations: { underline: true, pointerCursor: true }, activate: () => handlers.current.onOpenUrl?.(l.url) };
          }
          if (!handlers.current.onOpenFile) return null;
          const path = await exists(l.path);
          if (!path) return null;
          return {
            range,
            text: l.text,
            decorations: { underline: true, pointerCursor: true },
            activate: () => handlers.current.onOpenFile?.(path, l.line),
          };
        }),
      ).then(links => {
        const shown = links.filter((x): x is ILink => x !== null);
        callback(shown.length ? shown : undefined);
      });
    },
  };
}

/** End one of the thread's terminals for good (its tab was closed). */
export function closeTerminal(connection: { url: string; token: () => Promise<string> } | null, terminal: string): void {
  if (!connection) return;
  const client = new TerminalClient({ url: terminalUrl(connection.url), token: connection.token, terminal, cols: 80, rows: 24, onData: () => {} });
  client.connect();
  client.kill();
  // Give up if the runner can't be reached soon; the shell ends with the runner anyway.
  setTimeout(() => client.close(), 15_000);
}
