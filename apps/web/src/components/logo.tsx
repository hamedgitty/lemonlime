import { LogoMark } from "./logo-mark.tsx";

/** The logo: the citrus-slice mark beside the lower-case wordmark. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark size={24} />
      <span aria-hidden="true" className="font-display text-[1.3rem] font-extrabold leading-none tracking-[-0.03em] text-ink">
        lemonlime
      </span>
      <span className="sr-only">LemonLime</span>
    </span>
  );
}
