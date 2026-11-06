/** Wordmark: a lemon-and-lime dot pair next to the name. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden className="relative inline-block h-5 w-7">
        <span className="absolute left-0 top-0 h-5 w-5 rounded-full bg-lemon ring-2 ring-cream" />
        <span className="absolute left-2.5 top-0 h-5 w-5 rounded-full bg-lime ring-2 ring-cream" />
      </span>
      <span className="font-display text-lg font-semibold tracking-tight">LemonLime</span>
    </span>
  );
}
