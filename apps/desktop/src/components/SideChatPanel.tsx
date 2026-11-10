import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import type { ThreadSession } from "../lib/useThreadSession.ts";
import { buildTimeline } from "../lib/timeline.ts";
import { Timeline } from "./Timeline.tsx";
import { Tip } from "./primitives.tsx";
import { cx } from "./ui.tsx";
import { composing } from "../lib/ime.ts";

const NONE: never[] = [];

/**
 * Side chats: ask about the thread without interrupting it. A separate agent answers from
 * a recap of the thread and can read files but never change them; nothing here goes into
 * the thread. Chats are thrown away when you start another or close them, unless pinned.
 */
export function SideChatPanel({ side, connected }: { side: ThreadSession["side"]; connected: boolean }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const chat = side.chats.find(c => c.id === current) ?? null;
  const events = current ? side.events[current] : undefined;
  const items = useMemo(() => buildTimeline(events ?? NONE), [events]);

  // A pinned chat opened from the list: fetch its messages. Asked once per opening, and again after a reconnect.
  const asked = useRef<string | null>(null);
  const loaded = events !== undefined;
  const { open } = side;
  useEffect(() => {
    if (!current || !connected) {
      asked.current = null;
      return;
    }
    if (loaded || asked.current === current) return;
    asked.current = current;
    open(current);
  }, [current, connected, loaded, open]);
  // The chat was closed elsewhere.
  useEffect(() => {
    if (current && !side.chats.some(c => c.id === current)) setCurrent(null);
  }, [current, side.chats]);

  const leave = () => {
    if (chat && !chat.pinned) side.close(chat.id);
    setCurrent(null);
  };
  const ask = async () => {
    const text = draft.trim();
    if (!text || chat?.busy) return;
    setDraft("");
    setError(null);
    try {
      setCurrent(await side.ask(text, current ?? undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDraft(text);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
      e.preventDefault();
      void ask();
    }
  };
  const pinned = side.chats.filter(c => c.pinned && c.id !== current);

  return (
    <div role="tabpanel" aria-label="Side chat" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 items-center gap-1 border-b border-line px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-[14px] text-ink-soft">{chat ? chat.title : "Ask about this thread without interrupting it."}</p>
        {chat && (
          <>
            <Tip label={chat.pinned ? "Unpin: discard when closed" : "Pin: keep this chat"} side="bottom">
              <button
                type="button"
                aria-label={chat.pinned ? "Unpin side chat" : "Pin side chat"}
                aria-pressed={chat.pinned}
                onClick={() => side.pin(chat.id, !chat.pinned)}
                className={cx("inline-flex size-7 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep", chat.pinned && "text-leaf")}
              >
                {chat.pinned ? <PinOff aria-hidden="true" className="size-4" /> : <Pin aria-hidden="true" className="size-4" />}
              </button>
            </Tip>
            <Tip label={chat.pinned ? "Close" : "New side chat (this one is discarded)"} side="bottom">
              <button
                type="button"
                aria-label="New side chat"
                onClick={leave}
                className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep"
              >
                <Plus aria-hidden="true" className="size-4" />
              </button>
            </Tip>
            {chat.pinned && (
              <Tip label="Delete this chat" side="bottom">
                <button
                  type="button"
                  aria-label="Delete side chat"
                  onClick={() => {
                    side.pin(chat.id, false);
                    side.close(chat.id);
                    setCurrent(null);
                  }}
                  className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </Tip>
            )}
          </>
        )}
      </div>

      {chat ? (
        <Timeline items={items} working={chat.busy && items[items.length - 1]?.kind !== "agent"} empty={null} />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
          <p className="text-[14px] text-ink-soft">
            Questions here go to a separate copy of the agent that has read the thread. It can look at files but can't change anything, and nothing you ask
            shows up in the thread.
          </p>
          {pinned.length > 0 && (
            <>
              <p className="mt-5 mb-1.5 text-[13px] font-medium text-ink-faint">Pinned</p>
              <ul className="flex flex-col gap-px">
                {pinned.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setCurrent(c.id)}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[14px] hover:bg-cream-deep"
                    >
                      <Pin aria-hidden="true" className="size-3.5 shrink-0 text-leaf" />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="border-t border-line p-2">
        {error && (
          <p role="alert" className="px-1 pb-1.5 text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-paper p-1.5 focus-within:border-leaf">
          <textarea
            aria-label="Ask about this thread"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            disabled={!connected}
            rows={Math.min(5, Math.max(1, draft.split("\n").length))}
            placeholder={connected ? (chat ? "Ask a follow-up…" : "Ask about this thread…") : "Opens once the thread is running"}
            className="min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="button"
            aria-label="Ask"
            disabled={!connected || !draft.trim() || Boolean(chat?.busy)}
            onClick={() => void ask()}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-cream-deep text-ink-soft enabled:bg-lime enabled:text-on-citrus disabled:opacity-60"
          >
            <ArrowUp aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
