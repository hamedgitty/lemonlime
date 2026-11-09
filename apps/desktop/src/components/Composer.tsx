import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, BookOpen, FileText, Mic, Puzzle, Square, SquareSlash } from "lucide-react";
import { joinDictation, startLevelMeter, useDictation } from "../lib/dictation.ts";
import { loadUiPrefs } from "../lib/storage.ts";
import { fuzzyFilter, fuzzyMatchPath, type AgentCommand, type FuzzyMatch } from "@lemonlime/protocol";
import { applyPick, detectTrigger, insertQuote, type Trigger } from "../lib/composerTriggers.ts";
import { HISTORY_IDLE, loadDraft, saveDraft, stepHistory, type HistoryState } from "../lib/promptHistory.ts";
import { caretCoordinates } from "../lib/caret.ts";
import { changedRange, replaceRange } from "../lib/textareaEdit.ts";
import { continueList, endList, indentLines, wrapSelection, type TextChange } from "../lib/composerMarkdown.ts";
import { enterAction, sendKeyLabel, type SendKey } from "../lib/composerSend.ts";
import { pasteBecomesFile } from "../lib/pastedText.ts";
import { IS_MAC } from "../lib/shortcuts.ts";
import { Highlighted } from "./Highlighted.tsx";
import { Kbd, Tip } from "./primitives.tsx";
import { cx } from "./ui.tsx";

export interface ComposerHandle {
  /** Put text in the box (e.g. a one-click prompt) and focus it. */
  fill(text: string): void;
  focus(): void;
  /** Add `text` as a `>` quote at the end of what's there, and focus. */
  quote(text: string): void;
  /** Add `text` as its own paragraph after what's there, and focus. */
  insert(text: string): void;
  /** Paste `text` at the caret, as if pasted into the box (a very long one may become a file). */
  paste(text: string): void;
}

/** Where the `/` and `@` menus get their entries (a thread's runner); leave out for no menus. */
export interface ComposerSuggestions {
  commands: AgentCommand[];
  /** Called when the `/` menu opens, to ask the runner again. */
  onCommandsOpen?: () => void;
  searchFiles?: (query: string, signal?: AbortSignal) => Promise<string[]>;
}

type Option = { id: string; kind: "command"; command: AgentCommand; match: FuzzyMatch } | { id: string; kind: "file"; path: string; match: FuzzyMatch };

const MENU_WIDTH = 380;

/**
 * The message card: a growing text box with a toolbar inside it. `tools` sits bottom-left
 * (agent and model pickers); the round send button turns lime once there's something
 * to send. Used on the home screen and docked under a thread.
 *
 * In a thread it also has typeahead (`/` for the agent's commands at the start, `@` for
 * files anywhere), Up and Down through earlier prompts, and a draft kept per thread.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    /** Send the message. Return false when it wasn't taken: the text stays in the box. */
    onSend: (text: string) => boolean;
    onInterrupt?: () => void;
    /** The agent is in the middle of a turn: show the stop button. */
    working?: boolean;
    disabled?: boolean;
    disabledReason?: string | undefined;
    placeholder?: string;
    tools?: ReactNode;
    /** Keep the text after sending (e.g. while a thread is being created). */
    busy?: boolean;
    autoFocus?: boolean;
    suggestions?: ComposerSuggestions;
    /** Earlier prompts in this thread, oldest first, for Up and Down. */
    history?: readonly string[];
    /** Keep unsent text under this key (a thread id) across switches and restarts. */
    draftKey?: string;
    /** A likely next message, shown greyed while the box is empty; Tab takes it. */
    suggestion?: string | null;
    /** Called as the text changes. */
    onTextChange?: (text: string) => void;
    /** ⌥Enter: hand the message over to be sent later (e.g. once subagents finish). */
    onHold?: (text: string) => boolean;
    /** A paste too long for the box: attach it as a file instead. Return false to paste it as text after all. */
    onLongPaste?: (text: string) => boolean;
  }
>(function Composer(
  {
    onSend,
    onInterrupt,
    working = false,
    disabled = false,
    disabledReason,
    placeholder,
    tools,
    busy = false,
    autoFocus,
    suggestions,
    history = [],
    draftKey,
    suggestion,
    onTextChange,
    onHold,
    onLongPaste,
  },
  handle,
) {
  const [text, setText] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const historyState = useRef<HistoryState>(HISTORY_IDLE);

  /**
   * Our own edits (menu picks, history, quotes, dictation) go in the way typing does, so ⌘Z
   * still takes them back. A disabled box can't be typed into, so it just takes the text.
   */
  const ownEdit = useRef(false);
  const setBox = (next: string, selStart = next.length, selEnd = selStart) => {
    const el = ref.current;
    if (!el || el.disabled) return setText(next);
    const r = changedRange(el.value, next);
    ownEdit.current = true;
    try {
      replaceRange(el, r.start, r.end, r.insert, [selStart, selEnd]);
    } finally {
      ownEdit.current = false;
    }
  };
  const applyChange = (c: TextChange) => setBox(c.text, c.selStart, c.selEnd);
  const current = () => ref.current?.value ?? textRef.current;
  // Voice input: each finished phrase lands at the end of the message.
  const dictation = useDictation(phrase => setBox(joinDictation(current(), phrase)));

  /** Pastes at the caret; a paste too long for the box becomes a file when the thread can take one. */
  const pasteText = (pasted: string) => {
    const el = ref.current;
    if (!el || el.disabled || !pasted) return;
    const { selectionStart: a, selectionEnd: b } = el;
    if (onLongPaste && pasteBecomesFile(pasted, el.value.length, b - a) && onLongPaste(pasted)) return el.focus();
    replaceRange(el, a, b, pasted);
  };
  /** ⌘⇧V pastes as text even when it's long. Set on the key, cleared by the paste it brings. */
  const plainPaste = useRef(false);

  useImperativeHandle(handle, () => ({
    fill: (t: string) => setBox(t),
    focus: () => ref.current?.focus(),
    quote: (selected: string) => setBox(insertQuote(current(), selected)),
    insert(t: string) {
      const cur = current();
      setBox(cur.trim() ? `${cur.trimEnd()}\n\n${t}` : t);
    },
    paste(t: string) {
      const el = ref.current;
      if (el && document.activeElement !== el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
      pasteText(t);
    },
  }));

  // Drafts: saved shortly after typing stops, and when the composer goes away.
  const textRef = useRef(text);
  textRef.current = text;
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  useEffect(() => onTextChangeRef.current?.(text), [text]);
  useEffect(() => {
    if (!draftKey) return;
    const t = setTimeout(() => saveDraft(draftKey, text), 300);
    return () => clearTimeout(t);
  }, [draftKey, text]);
  useEffect(() => () => void (draftKey && saveDraft(draftKey, textRef.current)), [draftKey]);

  // Grow with the content up to a limit. Measure again when the width changes (the first
  // layout can happen before the column has its final width, which wraps the placeholder).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
    };
    fit();
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  // ── Typeahead ──
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  /** The trigger the user closed with Escape stays closed until they type a new one. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<{ query: string; paths: string[] } | null>(null);
  const [filesError, setFilesError] = useState(false);
  const readTrigger = () => {
    const el = ref.current;
    if (!el || !suggestions) return setTrigger(null);
    const t = detectTrigger(el.value, el.selectionStart, el.selectionEnd);
    if (t && t.kind === "file" && !suggestions.searchFiles) return setTrigger(null);
    setTrigger(prev => (prev && t && prev.kind === t.kind && prev.start === t.start && prev.query === t.query && prev.end === t.end ? prev : t));
  };
  const menuTrigger = trigger && trigger.start !== dismissedAt && !disabled ? trigger : null;
  const kind = menuTrigger?.kind ?? null;

  const { onCommandsOpen, searchFiles } = suggestions ?? {};
  useEffect(() => {
    if (kind === "command") onCommandsOpen?.();
  }, [kind, onCommandsOpen]);

  const fileQuery = menuTrigger?.kind === "file" ? menuTrigger.query : null;
  useEffect(() => {
    if (fileQuery === null || !searchFiles) return;
    const ctl = new AbortController();
    const t = setTimeout(
      () =>
        void searchFiles(fileQuery, ctl.signal).then(
          paths => {
            setFilesError(false);
            setFiles({ query: fileQuery, paths });
          },
          () => !ctl.signal.aborted && setFilesError(true),
        ),
      fileQuery ? 60 : 0,
    );
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [fileQuery, searchFiles]);

  const commands = suggestions?.commands;
  const options: Option[] = useMemo(() => {
    if (!menuTrigger) return [];
    if (menuTrigger.kind === "command")
      return fuzzyFilter(commands ?? [], menuTrigger.query, c => c.name, { limit: 50 }).map(r => ({
        id: `c:${r.item.name}`,
        kind: "command" as const,
        command: r.item,
        match: r.match,
      }));
    return (files?.paths ?? []).map(path => ({
      id: `f:${path}`,
      kind: "file" as const,
      path,
      match: fuzzyMatchPath(menuTrigger.query, path) ?? { score: 0, positions: [] },
    }));
  }, [menuTrigger, commands, files]);
  const open = menuTrigger !== null;
  useEffect(() => setActive(0), [kind, menuTrigger?.query]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const wrap = wrapRef.current;
    if (!open || !el || !wrap || !menuTrigger) return setMenuPos(null);
    const c = caretCoordinates(el, menuTrigger.start);
    const er = el.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const left = Math.max(0, Math.min(er.left - wr.left + c.left - 8, wr.width - MENU_WIDTH));
    const caretTop = er.top - wr.top + Math.max(0, c.top);
    setMenuPos({ left, bottom: wr.height - caretTop + 6 });
  }, [open, menuTrigger]);

  // Keep the highlighted option in view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`#${CSS.escape(optionId(activeIndex))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  const pick = (o: Option) => {
    if (!menuTrigger) return;
    const next = applyPick(text, menuTrigger, o.kind === "command" ? o.command.name : o.path);
    setBox(next.text, next.caret);
    setTrigger(null);
  };

  const canSend = !disabled && !busy && text.trim().length > 0;
  const submit = (send: (text: string) => boolean = onSend) => {
    if (!canSend) return;
    // A message that wasn't taken (still uploading, not connected) stays as typed.
    if (!send(text.trim())) return ref.current?.focus();
    // Sending ends dictation, so a late phrase doesn't start the next message.
    if (dictation.listening) dictation.stop();
    setText("");
    historyState.current = HISTORY_IDLE;
    setTrigger(null);
    if (draftKey) saveDraft(draftKey, "");
    ref.current?.focus();
  };

  const offered = !disabled && !working && text === "" && suggestion ? suggestion : null;
  const hintId = useId();
  // Read again whenever the box gets focus, so a change in Settings applies straight away.
  const [sendKey, setSendKey] = useState<SendKey>(() => loadUiPrefs().sendKey);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const plainKeys = !e.altKey && !e.metaKey && !e.ctrlKey;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") {
      // Where ⌘⇧V brings no paste of its own, read the clipboard instead.
      plainPaste.current = true;
      const el = e.currentTarget;
      setTimeout(() => {
        if (!plainPaste.current) return;
        plainPaste.current = false;
        void navigator.clipboard
          ?.readText()
          .then(t => t && replaceRange(el, el.selectionStart, el.selectionEnd, t))
          .catch(() => undefined);
      }, 80);
      return;
    }
    if (offered && e.key === "Tab" && !e.shiftKey && plainKeys) {
      e.preventDefault();
      setBox(offered);
      return;
    }
    if (open) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedAt(menuTrigger!.start);
        return;
      }
      if (options.length > 0) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          setActive((activeIndex + step + options.length) % options.length);
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          pick(options[activeIndex]!);
          return;
        }
      }
    }
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    // Markdown aids: wrap a selection, indent list items and code, carry lists on.
    const change = (c: TextChange | null) => {
      if (!c) return false;
      e.preventDefault();
      applyChange(c);
      return true;
    };
    if (plainKeys && a !== b && change(wrapSelection(value, a, b, e.key))) return;
    if (e.key === "Tab" && plainKeys && change(indentLines(value, a, b, e.shiftKey))) return;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && plainKeys) {
      const step = stepHistory(history, historyState.current, e.key === "ArrowUp" ? "up" : "down", { text, caret: a });
      if (step) {
        e.preventDefault();
        historyState.current = step.state;
        setBox(step.text, e.key === "ArrowUp" ? 0 : step.text.length);
        return;
      }
    }
    if (e.key === "Enter") {
      const action = enterAction(e, sendKey, value);
      // A new line: in a list it starts the next item (or ends the list on an empty one).
      if (action === "newline") return void change(continueList(value, a, b));
      e.preventDefault();
      // Enter on an empty list item ends the list rather than sending.
      if (action === "send" && plainKeys && !e.shiftKey && a === b && change(endList(value, a))) return;
      submit(action === "hold" && onHold ? onHold : onSend);
      return;
    }
    if (e.key === "Escape" && working && onInterrupt) {
      e.preventDefault();
      onInterrupt();
    }
  };

  return (
    <div ref={wrapRef} className="relative" data-composer="">
      <div
        className={cx(
          "rounded-xl border border-line bg-paper shadow-panel transition-[border-color,box-shadow] duration-150",
          "focus-within:border-line-strong focus-within:shadow-[0_1px_2px_rgb(23_32_14/0.04),0_6px_20px_rgb(23_32_14/0.07)]",
        )}
      >
        <label htmlFor="composer" className="sr-only">
          Message the agent
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={2}
          value={text}
          autoFocus={autoFocus}
          onChange={e => {
            setText(e.target.value);
            if (!ownEdit.current) historyState.current = HISTORY_IDLE;
            if (dismissedAt !== null && !detectTrigger(e.target.value, e.target.selectionStart)) setDismissedAt(null);
            readTrigger();
          }}
          onSelect={readTrigger}
          onFocus={() => setSendKey(loadUiPrefs().sendKey)}
          onBlur={() => setTrigger(null)}
          onKeyDown={onKeyDown}
          onPaste={e => {
            const inline = plainPaste.current;
            plainPaste.current = false;
            // Files are attached by the thread; ⌘⇧V pastes the text as it is.
            if (inline || e.clipboardData.files.length || !onLongPaste) return;
            const pasted = e.clipboardData.getData("text/plain");
            const el = e.currentTarget;
            if (pasted && pasteBecomesFile(pasted, el.value.length, el.selectionEnd - el.selectionStart) && onLongPaste(pasted)) e.preventDefault();
          }}
          dir="auto"
          disabled={disabled}
          placeholder={
            disabled
              ? (disabledReason ?? "Not connected")
              : (offered ?? placeholder ?? (working ? "Add to the conversation…" : "Ask the agent to build anything…"))
          }
          aria-describedby={offered ? hintId : undefined}
          {...(suggestions
            ? {
                role: "combobox",
                "aria-autocomplete": "list" as const,
                "aria-expanded": open,
                "aria-controls": open ? listId : undefined,
                "aria-activedescendant": open && options.length > 0 ? optionId(activeIndex) : undefined,
              }
            : {})}
          className={cx(
            "block max-h-[260px] min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed",
            offered && "pr-24",
          )}
        />
        {offered && (
          <span id={hintId} className="pointer-events-none absolute top-3.5 right-3 inline-flex items-center gap-1 text-[13px] text-ink-faint">
            <span className="sr-only">Suggested reply: {offered}.</span>
            <Kbd>Tab</Kbd>
            <span aria-hidden="true">to use</span>
            <span className="sr-only">Press Tab to use it.</span>
          </span>
        )}
        {dictation.listening && <DictationBar interim={dictation.interim} onStop={dictation.stop} />}
        {dictation.error && !dictation.listening && (
          <p role="alert" className="px-4 pb-1 text-[13px] text-danger">
            {dictation.error}
          </p>
        )}
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          {/* In a narrow column the pickers are cut off rather than running under the buttons. */}
          <div className="-m-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden p-1">{tools}</div>
          {dictation.supported && !disabled && (
            <Tip label={dictation.listening ? "Stop dictating" : "Dictate"}>
              <button
                type="button"
                onClick={dictation.toggle}
                aria-label={dictation.listening ? "Stop dictating" : "Dictate a message"}
                aria-pressed={dictation.listening}
                className={cx(
                  "inline-flex size-[34px] shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-cream-deep hover:text-ink",
                  dictation.listening && "bg-lime text-ink hover:bg-lime",
                )}
              >
                <Mic aria-hidden="true" className="size-4" />
              </button>
            </Tip>
          )}
          {working && onInterrupt && (
            <Tip
              label={
                <>
                  Stop the agent <span className="font-normal opacity-75">Esc</span>
                </>
              }
            >
              <button
                type="button"
                onClick={onInterrupt}
                aria-label="Stop the agent"
                className="inline-flex size-[34px] items-center justify-center rounded-full border border-line-strong bg-paper text-ink hover:bg-cream"
              >
                <Square aria-hidden="true" className="size-3 fill-current" />
              </button>
            </Tip>
          )}
          <button
            type="button"
            onClick={() => submit()}
            disabled={!canSend}
            aria-label="Send message"
            title={`Send (${sendKeyLabel(sendKey, text, IS_MAC ? "⌘" : "Ctrl+")})`}
            className={cx(
              "inline-flex size-[34px] shrink-0 items-center justify-center rounded-full transition-colors duration-150",
              canSend ? "bg-lime text-ink hover:bg-[#b2ec52]" : "bg-cream-deep text-ink-faint",
            )}
          >
            <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {open && menuPos && (
        <SuggestionMenu
          id={listId}
          listRef={listRef}
          kind={menuTrigger!.kind}
          options={options}
          active={activeIndex}
          optionId={optionId}
          onActive={setActive}
          onPick={pick}
          loading={menuTrigger!.kind === "file" && !filesError && files?.query !== menuTrigger!.query}
          failed={menuTrigger!.kind === "file" && filesError}
          style={{ left: menuPos.left, bottom: menuPos.bottom, width: MENU_WIDTH }}
        />
      )}
    </div>
  );
});

const BARS = 28;

/**
 * Shown while dictating: a live level meter from the microphone, what's being heard so far,
 * and Stop. The meter is drawn by moving bars (transforms only), never by re-rendering.
 */
function DictationBar({ interim, onStop }: { interim: string; onStop: () => void }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const [meter, setMeter] = useState<"on" | "off">("on");
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    const levels: number[] = Array.from({ length: BARS }, () => 0);
    void startLevelMeter(loadUiPrefs().micDeviceId, level => {
      levels.shift();
      levels.push(level);
      levels.forEach((l, i) => {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${Math.max(0.12, l)})`;
      });
    }).then(
      s => (cancelled ? s() : (stop = s)),
      () => !cancelled && setMeter("off"),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return (
    <div className="mx-2.5 mb-1 flex h-9 items-center gap-3 rounded-lg bg-cream-deep pr-1 pl-3">
      {meter === "on" ? (
        <span aria-hidden="true" className="flex h-5 shrink-0 items-center gap-[2px]">
          {Array.from({ length: BARS }, (_, i) => (
            <span
              key={i}
              ref={el => {
                bars.current[i] = el;
              }}
              className="h-5 w-[3px] origin-center scale-y-[0.12] rounded-full bg-leaf transition-transform duration-75 ease-out"
            />
          ))}
        </span>
      ) : (
        <Mic aria-hidden="true" className="size-4 shrink-0 text-leaf" />
      )}
      <p role="status" className="min-w-0 flex-1 truncate text-[14px] text-ink-soft">
        {interim || "Listening…"}
      </p>
      <button
        type="button"
        onClick={onStop}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[14px] font-medium text-ink hover:bg-cream-hover"
      >
        <Square aria-hidden="true" className="size-3 fill-current" />
        Stop
      </button>
    </div>
  );
}

const SOURCE_LABEL: Record<AgentCommand["source"], string> = {
  agent: "",
  project: "Project",
  user: "Yours",
  skill: "Skill",
  plugin: "Plugin",
};

/** The `/` or `@` list. Opens instantly (it follows typing); focus stays in the text box. */
function SuggestionMenu({
  id,
  listRef,
  kind,
  options,
  active,
  optionId,
  onActive,
  onPick,
  loading,
  failed,
  style,
}: {
  id: string;
  listRef: React.RefObject<HTMLDivElement | null>;
  kind: "command" | "file";
  options: Option[];
  active: number;
  optionId: (i: number) => string;
  onActive: (i: number) => void;
  onPick: (o: Option) => void;
  loading: boolean;
  failed: boolean;
  style: React.CSSProperties;
}) {
  const empty = failed
    ? "Couldn't list the files. Is the runner connected?"
    : loading
      ? "Looking for files…"
      : kind === "file"
        ? "No matching files"
        : "No matching commands. The agent lists its own after its first reply.";
  return (
    <div className="absolute z-40 overflow-hidden rounded-[10px] border border-line bg-paper text-[14px] text-ink shadow-pop" style={style}>
      <p className="border-b border-line px-3 py-1.5 text-[13px] font-medium text-ink-faint">{kind === "file" ? "Files" : "Commands"}</p>
      <div ref={listRef} id={id} role="listbox" aria-label={kind === "file" ? "Files" : "Commands"} className="scroll-thin max-h-[280px] overflow-y-auto p-1">
        {options.length === 0 ? (
          <p className="px-2.5 py-2 text-[14px] text-ink-soft">{empty}</p>
        ) : (
          options.map((o, i) => {
            const selected = i === active;
            return (
              <div
                key={o.id}
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                onMouseDown={e => e.preventDefault()}
                onMouseMove={() => !selected && onActive(i)}
                onClick={() => onPick(o)}
                className={cx("flex h-8 cursor-default items-center gap-2.5 rounded-[7px] px-2.5", selected && "bg-cream-deep")}
              >
                {o.kind === "command" ? <CommandRow command={o.command} match={o.match} /> : <FileRow path={o.path} match={o.match} />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function CommandRow({ command, match }: { command: AgentCommand; match: FuzzyMatch }) {
  const Icon = command.source === "skill" ? BookOpen : command.source === "plugin" ? Puzzle : SquareSlash;
  const tag = SOURCE_LABEL[command.source];
  return (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
      <span className="shrink-0 font-mono text-[13px]">
        /<Highlighted text={command.name} positions={match.positions} />
      </span>
      {command.hint && <span className="shrink-0 font-mono text-[13px] text-ink-faint">{command.hint}</span>}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{command.description}</span>
      {tag && <span className="shrink-0 text-[13px] text-ink-faint">{tag}</span>}
    </>
  );
}

function FileRow({ path, match }: { path: string; match: FuzzyMatch }) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  return (
    <>
      <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
      <span className="shrink-0 truncate">
        <Highlighted text={name} positions={match.positions} offset={slash + 1} />
      </span>
      {dir && (
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint" dir="rtl">
          {/* rtl keeps the end of a long folder path visible; the bidi isolate keeps it in order. */}
          <bdi>
            <Highlighted text={dir} positions={match.positions.filter(p => p < slash)} />
          </bdi>
        </span>
      )}
    </>
  );
}

/** A quiet pill in the composer toolbar or under it: icon, label, chevron. */
export const PickerButton = forwardRef<
  HTMLButtonElement,
  { icon?: ReactNode; children: ReactNode; chevron?: boolean; tone?: "plain" | "muted" } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function PickerButton({ icon, children, chevron = true, tone = "plain", className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cx(
        "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium transition-colors duration-100 hover:bg-cream-deep data-[popup-open]:bg-cream-deep [&_svg]:size-4 [&_svg]:shrink-0",
        tone === "muted" ? "text-ink-soft" : "text-ink",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {chevron && (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="!size-3.5 text-ink-faint">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
});
