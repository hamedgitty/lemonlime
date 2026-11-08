import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Toggle } from "../primitives.tsx";
import { cx } from "../ui.tsx";

/** Building blocks every Settings page uses. */

export function Section({ title, description, children, aside }: { title?: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-8">
      {(title || aside) && (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            {title && <h3 className="font-sans text-[15px] font-semibold tracking-normal">{title}</h3>}
            {description && <p className="mt-0.5 text-[13.5px] text-ink-soft">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-5 rounded-xl border border-line bg-paper p-5">{children}</div>
    </section>
  );
}

export function Row({ label, description, htmlFor, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      <div className="min-w-0 flex-1 basis-[240px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[15px] text-ink">
            {label}
          </label>
        ) : (
          <p className="text-[15px] text-ink">{label}</p>
        )}
        {description && <div className="mt-0.5 text-[13.5px] text-ink-soft">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A row whose control is an on/off switch, labelled by the row. */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row label={label} description={description}>
      <Toggle label={label} checked={checked} onChange={onChange} {...(disabled !== undefined ? { disabled } : {})} />
    </Row>
  );
}

/** A labelled native select, styled like the rest. */
export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={e => onChange(e.target.value as T)}
      className={cx(
        "h-9 rounded-lg border border-line-strong bg-paper px-2.5 text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf",
        className ?? "w-[220px]",
      )}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SavedNote({ show, text = "Saved" }: { show: boolean; text?: string }) {
  return show ? (
    <span role="status" className="inline-flex items-center gap-1.5 text-[13.5px] text-leaf">
      <Check aria-hidden="true" className="size-4" />
      {text}
    </span>
  ) : null;
}

export function useSaved(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    saved,
    () => {
      setSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    },
  ];
}

/** Tabs across the top of a Settings page. */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number }[] }) {
  const id = useId();
  // Arrow keys move between tabs (and show them), as tabs do everywhere.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex(t => t.id === value);
    const n = tabs.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(tabs[to]!.id);
    document.getElementById(`${id}-${tabs[to]!.id}`)?.focus();
  };
  return (
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- the tabs inside take the focus
    <div role="tablist" aria-label="Sections" onKeyDown={onKeyDown} className="mb-6 flex flex-wrap gap-1 border-b border-line">
      {tabs.map(t => (
        <button
          key={t.id}
          id={`${id}-${t.id}`}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={cx(
            "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-[14px] transition-colors duration-100",
            value === t.id ? "border-ink font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-cream-deep px-1.5 text-[12px] text-ink-soft tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pill({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "good" | "warn" | "bad" }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap",
        tone === "good" && "bg-lime-soft text-leaf-deep",
        tone === "warn" && "bg-lemon-soft text-ink",
        tone === "bad" && "bg-danger-soft text-danger",
        tone === "plain" && "bg-cream-deep text-ink-soft",
      )}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-[13.5px] text-danger">
      {children}
    </p>
  ) : null;
}

export const code = "font-mono text-[12.5px] text-ink";
