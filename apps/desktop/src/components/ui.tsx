import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
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
  primary:
    "bg-lemon text-ink border border-[#e9c900] shadow-[inset_0_-1px_0_rgb(0_0_0/0.08)] hover:bg-[#ffe84f] active:bg-[#f5d400]",
  secondary: "bg-white text-ink border border-line-strong hover:bg-cream hover:border-ink-faint/50",
  ghost: "text-ink-soft hover:text-ink hover:bg-ink/5 border border-transparent",
  danger: "bg-white text-danger border border-danger/30 hover:bg-danger-soft",
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
        "inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-colors duration-150 disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-8 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
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
  "w-full rounded-[10px] border border-line-strong bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint/80 transition-colors focus:border-leaf focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-leaf/40";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputClass, className)} {...rest} />;
});

const DOT: Record<DisplayStatus, string> = {
  provisioning: "bg-lemon animate-pulse-soft",
  idle: "bg-lime",
  running: "bg-lime animate-pulse-soft shadow-[0_0_0_3px_rgb(163_230_53/0.25)]",
  paused: "bg-[#c9c2a0]",
  stopped: "bg-[#c9c2a0]",
  failed: "bg-[#e5484d]",
  offline: "border border-[#9aa58d] bg-transparent",
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
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <span className="absolute inset-0 rounded-full bg-lime" style={{ clipPath: "inset(0 0 0 50%)" }} />
      <span className="absolute inset-0 rounded-full bg-lemon" style={{ clipPath: "inset(0 50% 0 0)" }} />
      <span className="absolute inset-[22%] rounded-full border-2 border-rind/25" />
    </span>
  );
}

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
              active ? "bg-white text-ink shadow-[0_1px_2px_rgb(23_32_14/0.08)]" : "text-ink-soft hover:text-ink",
              o.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-leaf",
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={active}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
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
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)}
    />
  );
}
