import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DisplayStatus } from "../lib/format.ts";
import { STATUS_LABELS } from "../lib/format.ts";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-lemon text-ink border border-lemon-edge shadow-[inset_0_-1px_0_rgb(0_0_0/0.08)] hover:bg-lemon-hover active:bg-lemon-press",
  secondary: "bg-paper text-ink border border-line-strong hover:bg-cream hover:border-ink-faint/50",
  ghost: "text-ink-soft hover:text-ink hover:bg-ink/5 border border-transparent",
  danger: "bg-paper text-danger border border-danger/30 hover:bg-danger-soft",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-lg",
  md: "h-9.5 px-3.5 text-sm gap-2 rounded-[10px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-[color,background-color,border-color,scale] duration-150 ease-(--ease-out) active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});

/**
 * The one icon button: 28px square, 8px corners, the row hover fill, and the app's focus ring.
 * Use `ICON_BUTTON` for a button that has to be rendered by something else (a menu trigger).
 */
export const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-soft transition-colors duration-150 hover:bg-cream-deep hover:text-ink focus-visible:rounded-lg disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton(
  { label, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx(ICON_BUTTON, className)} {...rest}>
      {children}
    </button>
  );
});

/** The one fill for list rows: a light one on hover, a step deeper for the chosen row. */
export const ROW_HOVER = "hover:bg-cream-deep";
export const rowFill = (selected: boolean) => (selected ? "bg-cream-hover" : ROW_HOVER);

/** True once `ms` have passed, so quick loads show nothing rather than a flash. */
export function useDelayed(ms = 300): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return shown;
}

/** A placeholder block while something loads. Nothing for the first 300ms. */
export function Skeleton({ className }: { className?: string }) {
  const shown = useDelayed();
  if (!shown) return null;
  return <span aria-hidden="true" className={cx("block animate-pulse-soft rounded-md bg-cream-deep", className)} />;
}

/** Placeholder rows for a list that is loading: a title line and a shorter line under it. */
export function SkeletonRows({ rows = 5, label = "Loading", tile = false }: { rows?: number; label?: string; tile?: boolean }) {
  const shown = useDelayed();
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-1 p-2">
      {shown &&
        Array.from({ length: rows }, (_, i) => (
          <div key={i} aria-hidden="true" className="flex items-start gap-3 rounded-lg px-2.5 py-2">
            {tile && <span className="size-9 shrink-0 animate-pulse-soft rounded-[10px] bg-cream-deep" />}
            <span className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
              <span className="h-3.5 animate-pulse-soft rounded bg-cream-deep" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
              <span className="h-3 animate-pulse-soft rounded bg-cream-deep/70" style={{ width: `${70 + ((i * 11) % 25)}%` }} />
            </span>
          </div>
        ))}
    </div>
  );
}

/** Placeholder paragraphs for a page or document that is loading. */
export function SkeletonText({ lines = 6, label = "Loading" }: { lines?: number; label?: string }) {
  const shown = useDelayed();
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2.5">
      {shown && (
        <>
          <span aria-hidden="true" className="mb-2 h-6 w-2/5 animate-pulse-soft rounded-md bg-cream-deep" />
          {Array.from({ length: lines }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="h-3.5 animate-pulse-soft rounded bg-cream-deep/80"
              style={{ width: `${i % 3 === 2 ? 60 : 92 - ((i * 7) % 12)}%` }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** A calm card for something that didn't load, with a way to try again. */
export function RetryCard({ title, detail, onRetry, busy }: { title: string; detail?: ReactNode; onRetry: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="mx-auto flex max-w-[420px] flex-col items-center gap-2 rounded-2xl border border-line bg-paper px-6 py-8 text-center">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {detail && <p className="text-[14px] text-ink-soft">{detail}</p>}
      <Button size="sm" className="mt-2" onClick={onRetry} disabled={busy}>
        {busy && <Spinner />}
        Try again
      </Button>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  optional,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  optional?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline gap-2 text-[13px] font-medium text-ink">
        {label}
        {optional && <span className="font-normal text-ink-faint">Optional</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "w-full rounded-[10px] border border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint transition-[border-color,box-shadow] duration-150 focus:border-leaf focus:shadow-[0_0_0_1px_var(--color-leaf)] focus:outline-none";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputClass, className)} {...rest} />;
});

const DOT: Record<DisplayStatus, string> = {
  provisioning: "bg-lemon animate-pulse-soft",
  idle: "bg-lime",
  running: "bg-lime animate-pulse-soft shadow-[0_0_0_3px_rgb(163_230_53/0.25)]",
  paused: "bg-status-idle",
  stopped: "bg-status-idle",
  failed: "bg-status-failed",
  offline: "border border-rind-muted bg-transparent",
};

export function StatusDot({ status, className }: { status: DisplayStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABELS[status]}
      title={STATUS_LABELS[status]}
      className={cx("inline-block size-2 shrink-0 rounded-full", DOT[status], className)}
    />
  );
}

/** A lemon-and-lime mark drawn with CSS so it needs no image asset. */
export { LogoMark } from "./LogoMark.tsx";

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; disabled?: boolean; hint?: string }>;
  label: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl border border-line bg-cream-deep/60 p-1">
      {options.map(o => {
        const active = o.value === value;
        return (
          <label
            key={o.value}
            title={o.hint}
            className={cx(
              "relative flex items-center justify-center gap-2 rounded-[9px] px-3 py-1.5 text-[13px] font-medium transition-colors",
              active ? "bg-paper text-ink shadow-[0_1px_2px_rgb(23_32_14/0.08)]" : "text-ink-soft hover:text-ink",
              o.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-leaf",
            )}
          >
            <input type="radio" name={name} className="sr-only" checked={active} disabled={o.disabled} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

/** Opens a link in the user's browser (desktop shell) or a new tab (plain browser). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)} />;
}
