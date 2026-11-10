import type { UsageNotice } from "@lemonlime/plugins";
import { safeActionLink } from "@/lib/links.ts";

const TONE: Record<UsageNotice["level"], string> = {
  info: "border-line bg-paper",
  warning: "border-amber-300 bg-amber-50",
  blocked: "border-red-200 bg-red-50",
};

/** The deployment's usage banner (e.g. running low on hours), above every dashboard page. Its link is shown only when it is safe to offer. */
export function UsageBanner({ notice }: { notice: UsageNotice | null }) {
  if (!notice) return null;
  const link = safeActionLink(notice.actionUrl);
  return (
    <div role={notice.level === "info" ? "status" : "alert"} className={`border-b ${TONE[notice.level]}`}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
        <p className="min-w-0 flex-1">{notice.message}</p>
        {link && (
          <a href={link} className="btn-primary h-8">
            {notice.actionLabel ?? "Continue"}
          </a>
        )}
      </div>
    </div>
  );
}
