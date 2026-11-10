import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui.tsx";

/** What went wrong, as text someone can paste into a bug report: the message, then where it happened. */
export function errorDetails(error: unknown, componentStack?: string | null): string {
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
  const lines = [`${e.name}: ${e.message}`];
  if (e.stack) lines.push(e.stack.replace(`${e.name}: ${e.message}`, "").trim());
  if (componentStack?.trim()) lines.push("Drawn by:", componentStack.trim());
  return lines.filter(Boolean).join("\n");
}

interface Props {
  /** Shown in place of the children once one of them fails to draw. `retry` draws them again. */
  fallback: (details: string, retry: () => void) => ReactNode;
  /** When this changes, a caught failure is cleared: a different thread starts fresh. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  details: string | null;
  resetKey: unknown;
}

/**
 * Keeps a failure while drawing one part of the window from blanking all of it. React
 * unmounts everything above a failed component up to the nearest one of these.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { details: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { details: errorDetails(error) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { details: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ details: errorDetails(error, info.componentStack) });
    console.error(error);
  }

  private retry = () => this.setState({ details: null });

  override render() {
    return this.state.details === null ? this.props.children : this.props.fallback(this.state.details, this.retry);
  }
}

/** Copies the failure's details; says so for a moment once it really has. */
function CopyDetails({ details }: { details: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(details)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : "Copy details"}
    </Button>
  );
}

/** The whole window failed to draw: say so, and offer a fresh start. */
export function WindowFailed({ details }: { details: string }) {
  return (
    <div role="alert" className="flex h-screen w-screen items-center justify-center bg-cream p-6 text-ink">
      {/* The window can still be moved by its top edge. */}
      <div data-tauri-drag-region className="fixed inset-x-0 top-0 h-[52px]" />
      <div className="flex max-w-[440px] flex-col items-center gap-2 text-center">
        <p className="font-display text-[20px] font-semibold">Something went wrong</p>
        <p className="text-[14px] text-ink-soft">LemonLime couldn't draw this window. Reload it to carry on. Your threads are kept.</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <CopyDetails details={details} />
        </div>
      </div>
    </div>
  );
}

/** One part of the window (a thread, a panel) failed to draw; the rest keeps working. */
export function PartFailed({ what, details, onRetry }: { what: string; details: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-[420px] flex-col items-center gap-2 rounded-2xl border border-line bg-paper px-6 py-8 text-center">
        <p className="text-[15px] font-medium text-ink">{what} couldn't be shown</p>
        <p className="text-[14px] text-ink-soft">Something in it failed to draw. The rest of the app is fine.</p>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
          <CopyDetails details={details} />
        </div>
      </div>
    </div>
  );
}

/** One row of a thread failed to draw: a line in its place, so the rest of the thread still reads. */
export function RowFailed({ details }: { details: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-soft">
      <span className="min-w-0 flex-1">This part of the thread couldn't be shown.</span>
      <CopyDetails details={details} />
    </div>
  );
}
