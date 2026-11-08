import { usageTone } from "../lib/agentUsage.ts";
import { cx } from "./ui.tsx";

const FILL = { ok: "bg-leaf", high: "bg-lemon-2", full: "bg-danger" } as const;

/**
 * A thin bar for how much of a limit is used: green, then lemon from 70%, red from 90%.
 * The one bar for plan limits and cloud hours alike, in the sidebar and in Settings.
 */
export function UsageBar({ percent, label, className }: { percent: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cx("block h-1.5 overflow-hidden rounded-full bg-cream-deep", className)}
    >
      <span className={cx("block h-full rounded-full", FILL[usageTone(pct)])} style={{ width: `${pct}%` }} />
    </span>
  );
}
