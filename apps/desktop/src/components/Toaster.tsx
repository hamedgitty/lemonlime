import type { ReactNode } from "react";
import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { cx } from "./ui.tsx";
import { keyedToast, threadToastChange, type KeyedToast } from "../lib/toasts.ts";

/**
 * Small notices at the bottom of the window ("Archived", "Pushed"), on Base UI's toast
 * primitive. Call `toast(...)` from anywhere; mount <Toaster> once.
 */
const manager = Toast.createToastManager();

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  /** A button in the toast, e.g. Undo. Pressing it closes the toast. */
  action?: { label: string; onClick: () => void };
  tone?: "info" | "error";
  /** Milliseconds; 0 keeps it until closed. */
  timeout?: number;
  /**
   * One kind of notice: a toast with the same key replaces the one showing, and the same
   * words again within 2 seconds are dropped (lib/toasts.ts).
   */
  key?: string;
  /** The thread it's about: plain while that thread is on screen, with "Open thread" while it isn't. */
  threadId?: string;
}

/** How the toasts know which threads are on screen, and open one (set by the app). */
interface ThreadHooks {
  visible: (threadId: string) => boolean;
  open: (threadId: string) => void;
}
let threadHooks: ThreadHooks | null = null;
export function connectToastThreads(hooks: ThreadHooks | null): void {
  threadHooks = hooks;
}

const keyed = new Map<string, KeyedToast & { id: string }>();
/** Open toasts about a thread that have no action of their own. */
const forThread = new Map<string, { threadId: string; offersOpen: boolean }>();

const plainText = (n: ReactNode) => (typeof n === "string" || typeof n === "number" ? String(n) : "");

function actionProps(id: string, action: { label: string; onClick: () => void }) {
  return {
    children: action.label,
    onClick: () => {
      action.onClick();
      manager.close(id);
    },
  };
}

function openThreadAction(threadId: string) {
  return { label: "Open thread", onClick: () => threadHooks?.open(threadId) };
}

export function toast(o: ToastOptions): string {
  const now = Date.now();
  const text = `${plainText(o.title)}\n${plainText(o.description)}`;
  const prev = o.key ? keyed.get(o.key) : undefined;
  const decision = o.key ? keyedToast(prev, text, now) : "add";
  if (decision === "drop" && prev) return prev.id;
  const id = decision === "replace" && prev ? prev.id : crypto.randomUUID();
  const offersOpen = Boolean(o.threadId && !o.action && threadHooks && !threadHooks.visible(o.threadId));
  const action = o.action ?? (offersOpen && o.threadId ? openThreadAction(o.threadId) : undefined);
  if (o.key) keyed.set(o.key, { id, at: now, text, open: true });
  if (o.threadId && !o.action) forThread.set(id, { threadId: o.threadId, offersOpen });
  manager.add({
    id,
    title: o.title,
    ...(o.description ? { description: o.description } : { description: undefined }),
    type: o.tone ?? "info",
    // A problem takes longer to read than "Archived".
    timeout: o.timeout ?? (o.tone === "error" ? 8000 : action ? 6000 : 4000),
    priority: o.tone === "error" ? "high" : "low",
    actionProps: action ? actionProps(id, action) : undefined,
    onClose: () => {
      forThread.delete(id);
      if (o.key && keyed.get(o.key)?.id === id) keyed.set(o.key, { ...keyed.get(o.key)!, open: false });
    },
  });
  return id;
}

/** The thread on screen changed: thread toasts gain "Open thread", or go once you're there. */
export function syncThreadToasts(): void {
  if (!threadHooks) return;
  for (const [id, t] of forThread) {
    const change = threadToastChange({ visible: threadHooks.visible(t.threadId), offersOpen: t.offersOpen, ownAction: false });
    if (change === "close") manager.close(id);
    else if (change === "offer-open") {
      forThread.set(id, { ...t, offersOpen: true });
      manager.update(id, { actionProps: actionProps(id, openThreadAction(t.threadId)) });
    }
  }
}

export function Toaster({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col-reverse gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map(t => (
    <Toast.Root
      key={t.id}
      toast={t}
      // What went wrong can be selected and copied, so dragging across it doesn't swipe it away.
      swipeDirection={t.type === "error" ? [] : undefined}
      className={cx(
        // Rise 16px from 0.97 with a slight blur in, leave faster (motion.md, Toasts).
        "relative rounded-xl border bg-paper shadow-pop outline-none",
        t.type === "error" ? "select-text" : "select-none",
        "transition-[opacity,transform,filter] duration-[350ms] ease-(--ease-out) data-[ending-style]:duration-[250ms]",
        "data-[starting-style]:translate-y-4 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[starting-style]:blur-[2px]",
        "data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[limited]:opacity-0",
        "motion-reduce:data-[starting-style]:translate-y-0 motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:translate-y-0",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-leaf",
        t.type === "error" ? "border-danger/30" : "border-line",
      )}
    >
      <Toast.Content className="flex items-center gap-3 py-2.5 pr-2 pl-3.5">
        <div className="min-w-0 flex-1">
          <Toast.Title className={cx("text-[14px] font-medium", t.type === "error" ? "text-danger" : "text-ink")} />
          <Toast.Description className="mt-0.5 text-[13px] break-words text-ink-soft" />
        </div>
        {t.actionProps && (
          <Toast.Action className="inline-flex h-8 shrink-0 items-center rounded-lg border border-line-strong bg-paper px-2.5 text-[13px] font-semibold text-ink hover:bg-cream active:scale-[0.97]" />
        )}
        <Toast.Close
          aria-label="Close"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-ink/5 hover:text-ink"
        >
          <X aria-hidden="true" className="size-3.5" />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}
