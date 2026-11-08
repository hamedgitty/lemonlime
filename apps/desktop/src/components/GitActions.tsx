import { useCallback, useEffect, useRef, useState } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CircleDashed,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  X,
} from "lucide-react";
import type { GitStatusResponse, PullRequestInfo } from "@lemonlime/protocol";
import type { CloudApi } from "../lib/cloud.ts";
import type { Connection } from "../lib/useThreadSession.ts";
import { createPullRequest, fetchGitStatus, fetchPullRequest, pushBranch, ReviewUnavailable } from "../lib/review.ts";
import { MenuItem, MenuSeparator } from "./primitives.tsx";
import { toast } from "./Toaster.tsx";
import { Spinner, cx, openExternal } from "./ui.tsx";

/** What the app knows about the thread's pull request; `state` is unknown without `gh`. */
export type PullRequestView = Omit<PullRequestInfo, "state" | "draft"> & { state?: PullRequestInfo["state"]; draft?: boolean };

export interface GitState {
  status: GitStatusResponse | null;
  pullRequest: PullRequestView | null;
  /** The runner answers the git API (false for older runners or threads without git). */
  available: boolean;
  busy: "push" | "pr" | null;
  push: () => Promise<void>;
  openPullRequest: (draft?: boolean) => Promise<void>;
  refresh: () => void;
}

const STATUS_POLL_MS = 60_000;

/** Git status and pull request for the open thread, refreshed when `refreshKey` changes. */
export function useGitState({
  connection,
  mode,
  threadId,
  cloudApi,
  refreshKey,
}: {
  connection: Connection | null;
  mode: "local" | "cloud";
  threadId: string;
  cloudApi: CloudApi | null;
  refreshKey: string;
}): GitState {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [pullRequest, setPullRequest] = useState<PullRequestView | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<GitState["busy"]>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const connRef = useRef(connection);
  connRef.current = connection;

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    const load = async () => {
      try {
        const s = await fetchGitStatus(connection);
        if (cancelled) return;
        setStatus(s);
        setAvailable(true);
        if (s.gh === "ready") {
          const pr = await fetchPullRequest(connection).catch(() => null);
          if (!cancelled && pr?.pullRequest) setPullRequest(pr.pullRequest);
        }
      } catch (err) {
        if (!cancelled && err instanceof ReviewUnavailable) setAvailable(false);
      }
    };
    const t = setTimeout(() => void load(), 500);
    const every = setInterval(() => void load(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(every);
    };
  }, [connection, refreshKey, tick]);

  // Cloud threads: a pull request opened through the control plane (from here or the web).
  useEffect(() => {
    if (mode !== "cloud" || !cloudApi) return;
    let cancelled = false;
    void cloudApi
      .pullRequestUrl(threadId)
      .then(url => {
        if (!cancelled && url) setPullRequest(pr => (pr && pr.url === url ? pr : { url, ...prNumber(url) }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mode, cloudApi, threadId, tick]);

  const push = async () => {
    const c = connRef.current;
    if (!c || busy) return;
    setBusy("push");
    try {
      await pushBranch(c);
      toast({ title: `Pushed ${status?.branch ?? "the branch"}` });
      refresh();
    } catch (err) {
      toast({ title: "Couldn't push the branch", description: err instanceof Error ? err.message : String(err), tone: "error", timeout: 8000 });
    } finally {
      setBusy(null);
    }
  };

  const openPullRequest = async (draft = false) => {
    if (busy) return;
    setBusy("pr");
    try {
      if (mode === "cloud" && cloudApi) {
        const r = await cloudApi.openPullRequest(threadId);
        setPullRequest({ url: r.url, ...prNumber(r.url) });
        await openExternal(r.url);
        return;
      }
      const c = connRef.current;
      if (!c) throw new Error("Start the thread first.");
      const r = await createPullRequest(c, draft ? { draft: true } : {});
      if (r.pullRequest) {
        setPullRequest(r.pullRequest);
        toast({ title: r.pullRequest.number ? `Pull request #${r.pullRequest.number} is open` : "The pull request is open" });
        await openExternal(r.pullRequest.url);
      } else if (r.compareUrl) {
        // No GitHub CLI here: GitHub's own page finishes it.
        await openExternal(r.compareUrl);
        toast({ title: "Branch pushed", description: "Finish the pull request in your browser." });
      } else throw new Error("This repository's remote isn't on GitHub, so there's no pull request page to open.");
      refresh();
    } catch (err) {
      toast({ title: "Couldn't open a pull request", description: err instanceof Error ? err.message : String(err), tone: "error", timeout: 8000 });
    } finally {
      setBusy(null);
    }
  };

  return { status, pullRequest, available, busy, push, openPullRequest, refresh };
}

function prNumber(url: string): { number?: number } {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? { number: Number(m[1]) } : {};
}

const SPLIT =
  "inline-flex h-8 items-center gap-1.5 border border-line-strong bg-paper text-[13px] font-medium text-ink hover:bg-cream disabled:pointer-events-none disabled:opacity-50";

/** The thread header's split button: the main git action, with the others in its menu. */
export function GitActionsButton({ git, mode }: { git: GitState; mode: "local" | "cloud" }) {
  const s = git.status;
  const pr = git.pullRequest;
  const canPush = Boolean(s?.hasRemote);
  const main = pr
    ? { label: "View pull request", icon: <ExternalLink aria-hidden="true" className="size-3.5" />, run: () => void openExternal(pr.url) }
    : { label: "Open pull request", icon: <GitPullRequest aria-hidden="true" className="size-3.5" />, run: () => void git.openPullRequest() };
  const disabled = git.busy !== null || (mode === "local" && !canPush && !pr);
  return (
    <div className="inline-flex">
      <button
        type="button"
        onClick={main.run}
        disabled={disabled}
        title={mode === "local" && !canPush && !pr ? "This repository has no remote named origin." : main.label}
        className={cx(SPLIT, "rounded-l-lg border-r-0 px-2.5")}
      >
        {git.busy === "pr" ? <Spinner /> : main.icon}
        <span className="@max-[640px]/head:sr-only">{main.label}</span>
      </button>
      <BaseMenu.Root>
        <BaseMenu.Trigger
          aria-label="More git actions"
          disabled={git.busy !== null}
          className={cx(SPLIT, "rounded-r-lg px-1.5 data-[popup-open]:bg-cream-deep")}
          render={<button type="button" />}
        >
          {git.busy === "push" ? <Spinner /> : <ChevronDown aria-hidden="true" className="size-3.5" />}
        </BaseMenu.Trigger>
        <BaseMenu.Portal>
          <BaseMenu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <BaseMenu.Popup className="z-50 min-w-[14rem] origin-(--transform-origin) rounded-[10px] border border-line bg-paper p-1 text-[14px] text-ink shadow-pop outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
              <MenuItem icon={<ArrowUpFromLine />} disabled={!canPush} onSelect={() => void git.push()}>
                {s && s.pushed && s.unpushed === 0 ? "Push branch (up to date)" : "Push branch"}
              </MenuItem>
              {pr ? (
                <MenuItem icon={<ExternalLink />} onSelect={() => void openExternal(pr.url)}>
                  View pull request
                </MenuItem>
              ) : (
                <>
                  <MenuItem icon={<GitPullRequest />} disabled={mode === "local" && !canPush} onSelect={() => void git.openPullRequest()}>
                    Open pull request
                  </MenuItem>
                  {mode === "local" && s?.gh === "ready" && (
                    <MenuItem icon={<GitPullRequestDraft />} disabled={!canPush} onSelect={() => void git.openPullRequest(true)}>
                      Open draft pull request
                    </MenuItem>
                  )}
                </>
              )}
              {mode === "local" && s && s.gh !== "ready" && !pr && (
                <>
                  <MenuSeparator />
                  <p className="px-2.5 py-1.5 text-[12.5px] leading-snug text-ink-faint">
                    {s.gh === "signed_out"
                      ? "Sign the GitHub CLI in (gh auth login) to open pull requests from here. Until then GitHub opens in your browser."
                      : "Without the GitHub CLI, GitHub opens in your browser to finish the pull request."}
                  </p>
                </>
              )}
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
      <span className="sr-only" aria-live="polite">
        {git.busy === "push" ? "Pushing the branch" : git.busy === "pr" ? "Opening a pull request" : ""}
      </span>
    </div>
  );
}

/** A quiet line above the composer: what's changed on the branch, and its pull request. */
export function GitStrip({ git, onOpenChanges }: { git: GitState; onOpenChanges: () => void }) {
  const s = git.status;
  const pr = git.pullRequest;
  if (!s && !pr) return null;
  const chip =
    "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 text-[12.5px] font-medium text-ink-soft hover:border-line-strong hover:text-ink";
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {s && (s.uncommittedFiles > 0 || s.committedFiles > 0) && (
        <button type="button" onClick={onOpenChanges} className={chip} title="Show the changes">
          {s.uncommittedFiles > 0 && (
            <span className="tabular-nums">
              {s.uncommittedFiles} not committed{s.committedFiles > 0 ? "," : ""}
            </span>
          )}
          {s.committedFiles > 0 && (
            <span className="tabular-nums">
              {s.committedFiles} {s.committedFiles === 1 ? "file" : "files"} changed on the branch
            </span>
          )}
        </button>
      )}
      {pr && <PullRequestPill pr={pr} />}
    </div>
  );
}

const PR_STYLE = {
  open: { label: "Open", icon: GitPullRequest, cls: "border-[#c9e89a] bg-lime-soft text-leaf-deep" },
  draft: { label: "Draft", icon: GitPullRequestDraft, cls: "border-line-strong bg-cream-deep text-ink-soft" },
  merged: { label: "Merged", icon: GitMerge, cls: "border-line-strong bg-cream-hover text-ink" },
  closed: { label: "Closed", icon: GitPullRequestClosed, cls: "border-danger/30 bg-danger-soft text-danger" },
} as const;

const CHECKS = {
  passing: { label: "Checks passing", icon: Check, cls: "text-leaf" },
  failing: { label: "Checks failing", icon: X, cls: "text-danger" },
  pending: { label: "Checks running", icon: CircleDashed, cls: "text-[#8A5A00]" },
} as const;

export function PullRequestPill({ pr }: { pr: PullRequestView }) {
  const key = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : pr.state === "open" ? "open" : null;
  const style = key ? PR_STYLE[key] : null;
  const Icon = style?.icon ?? GitPullRequest;
  const checks = pr.checks && pr.checks !== "none" && pr.state === "open" ? CHECKS[pr.checks] : null;
  return (
    <button
      type="button"
      onClick={() => void openExternal(pr.url)}
      title={pr.url}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium whitespace-nowrap hover:brightness-[0.98]",
        style?.cls ?? "border-line bg-paper text-ink-soft",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span>{pr.number ? `Pull request #${pr.number}` : "Pull request"}</span>
      {style && <span className="font-semibold">{style.label}</span>}
      {checks && (
        <span className={cx("inline-flex items-center gap-1 border-l border-current/20 pl-1.5", checks.cls)}>
          <checks.icon aria-hidden="true" className="size-3.5" />
          {checks.label}
        </span>
      )}
    </button>
  );
}
