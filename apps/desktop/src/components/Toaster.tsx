import type { ReactNode } from "react";
import { Toast } from "@base-ui/react/toast";
import { X } from "lucide-react";
import { cx } from "./ui.tsx";

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
}

export function toast(o: ToastOptions): string {
  let id = "";
  id = manager.add({
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    type: o.tone ?? "info",
    timeout: o.timeout ?? (o.action ? 6000 : 4000),
    priority: o.tone === "error" ? "high" : "low",
    ...(o.action
      ? {
          actionProps: {
            children: o.action.label,
            onClick: () => {
              o.action!.onClick();
              manager.close(id);
            },
          },
        }
      : {}),
  });
  return id;
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
      className={cx(
        // Rise 16px from 0.97 with a slight blur in, leave faster (motion.md, Toasts).
        "relative rounded-xl border bg-paper shadow-pop outline-none select-none",
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
          <Toast.Description className="mt-0.5 text-[13px] text-ink-soft" />
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
