import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalClient, terminalUrl, type TerminalState } from "@lemonlime/client";
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
}) {
  const termRef = useRef<Terminal | null>(null);
  const names = useRef({ onName, onTitle });
  names.current = { onName, onTitle };
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
    const client = new TerminalClient({
      url: terminalUrl(connection.url),
      token: connection.token,
      ...(terminal ? { terminal } : {}),
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
      termRef.current = null;
      input.dispose();
      resize.dispose();
      client.close();
      clientRef.current = null;
      term.dispose();
    };
  }, [connection, terminal]);

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
  const note = LABELS[state];
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-rind">
      {note && (
        <div role="status" className="flex items-center gap-3 border-b border-rind-line px-3 py-2 text-[13px] text-rind-muted">
          <span className="flex-1">
            {note}
            {detail ? ` ${detail}` : ""}
          </span>
          {state === "exited" && (
            <Button size="sm" variant="secondary" onClick={() => clientRef.current?.restart()}>
              New shell
            </Button>
          )}
        </div>
      )}
      <div ref={host} aria-label="Terminal" className="min-h-0 flex-1 px-2 py-1.5" />
    </div>
  );
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
