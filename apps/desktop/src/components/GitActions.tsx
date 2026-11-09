import { useCallback, useEffect, useRef, useState } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  CircleDashed,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  TriangleAlert,
  X,
} from "lucide-react";
import type { GitStatusResponse, PullRequestDraft, PullRequestInfo, PullRequestWatchState } from "@lemonlime/protocol";
import type { CloudApi } from "../lib/cloud.ts";
import type { Connection } from "../lib/useThreadSession.ts";
import {
  compareUrlWithDraft,
  conflictsPrompt,
  createPullRequest,
  fetchGitStatus,
  fetchPullRequest,
  fetchPullRequestDraft,
  pushBranch,
  ReviewUnavailable,
  updateFromBase as postUpdateFromBase,
  watchPullRequest,
} from "../lib/review.ts";
import { PullRequestDraftDialog } from "./GitDialogs.tsx";
import { MenuItem, MenuSeparator, Tip } from "./primitives.tsx";
import { toast } from "./Toaster.tsx";
import { Button, Spinner, cx, openExternal } from "./ui.tsx";

/** What the app knows about the thread's pull request; `state` is unknown without `gh`. */
export type PullRequestView = Omit<PullRequestInfo, "state" | "draft"> & { state?: PullRequestInfo["state"]; draft?: boolean };

export interface GitState {
  status: GitStatusResponse | null;
  pullRequest: PullRequestView | null;
  /** Whether the runner is watching the pull request for the agent (runners that can). */
  watch: PullRequestWatchState | null;
  /** Why the agent can't push to the pull request's branch, when it can't. */
  pushProblem: string | null;
  /** The last update from the base branch stopped on these conflicts. */
  conflicts: { base: string; files: string[] } | null;
  /** The runner answers the git API (false for older runners or threads without git). */
  available: boolean;
  busy: "push" | "pr" | "update" | "watch" | null;
  push: () => Promise<void>;
  /** Resolves true once it's open (or handed to the browser). */
  openPullRequest: (draft?: boolean, text?: PullRequestDraft) => Promise<boolean>;
  /** A title and description for the pull request, from the runner. */
  loadDraft: () => Promise<PullRequestDraft>;
  updateFromBase: () => Promise<void>;
  setWatch: (on: boolean) => Promise<void>;
  clearConflicts: () => void;
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
  const [watch, setWatchState] = useState<PullRequestWatchState | null>(null);
  const [pushProblem, setPushProblem] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<GitState["conflicts"]>(null);
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
          if (cancelled || !pr) return;
          if (pr.pullRequest) setPullRequest(pr.pullRequest);
          setWatchState(pr.watch ?? null);
          setPushProblem(pr.pushProblem ?? null);
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

  const openPullRequest = async (draft = false, text?: PullRequestDraft) => {
    if (busy) return false;
    setBusy("pr");
    try {
      if (mode === "cloud" && cloudApi) {
        const r = await cloudApi.openPullRequest(threadId);
        setPullRequest({ url: r.url, ...prNumber(r.url) });
        await openExternal(r.url);
        return true;
      }
      const c = connRef.current;
      if (!c) throw new Error("Start the thread first.");
      const r = await createPullRequest(c, { ...(draft ? { draft: true } : {}), ...(text ? { title: text.title, body: text.body } : {}) });
      if (r.pullRequest) {
        setPullRequest(r.pullRequest);
        toast({ title: r.pullRequest.number ? `Pull request #${r.pullRequest.number} is open` : "The pull request is open" });
        await openExternal(r.pullRequest.url);
      } else if (r.compareUrl) {
        // No GitHub CLI here: GitHub's own page finishes it, with the title and description filled in.
        await openExternal(text ? compareUrlWithDraft(r.compareUrl, text) : r.compareUrl);
        toast({ title: "Branch pushed", description: "Finish the pull request in your browser." });
      } else throw new Error("This repository's remote isn't on GitHub, so there's no pull request page to open.");
      refresh();
      return true;
    } catch (err) {
      toast({ title: "Couldn't open a pull request", description: err instanceof Error ? err.message : String(err), tone: "error", timeout: 8000 });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const loadDraft = async () => {
    const c = connRef.current;
    if (!c) throw new Error("Start the thread first.");
    return fetchPullRequestDraft(c);
  };

  const updateFromBase = async () => {
    const c = connRef.current;
    if (!c || busy) return;
    setBusy("update");
    const base = status?.baseBranch ?? "the base branch";
    try {
      const r = await postUpdateFromBase(c);
      if (r.result === "conflicts") {
        setConflicts({ base: r.base, files: r.conflicts });
        toast({ title: `${base} doesn't merge cleanly`, description: "Nothing was changed. The agent can merge it and sort out the conflicts." });
      } else {
        setConflicts(null);
        toast({ title: r.result === "merged" ? `Brought in the latest from ${r.base}` : `Already up to date with ${r.base}` });
      }
      refresh();
    } catch (err) {
      toast({ title: `Couldn't update from ${base}`, description: err instanceof Error ? err.message : String(err), tone: "error", timeout: 8000 });
    } finally {
      setBusy(null);
    }
  };

  const setWatch = async (on: boolean) => {
    const c = connRef.current;
    if (!c || busy) return;
    setBusy("watch");
    try {
      setWatchState(await watchPullRequest(c, on));
      toast({
        title: on ? "Watching the pull request" : "Stopped watching the pull request",
        ...(on ? { description: "The agent gets a message when checks fail, comments arrive or the branch has merge conflicts." } : {}),
      });
    } catch (err) {
      toast({ title: "Couldn't change the watch", description: err instanceof Error ? err.message : String(err), tone: "error", timeout: 8000 });
    } finally {
      setBusy(null);
    }
  };

  return {
    status,
    pullRequest,
    watch,
    pushProblem,
    conflicts,
    available,
    busy,
    push,
    openPullRequest,
    loadDraft,
    updateFromBase,
    setWatch,
    clearConflicts: () => setConflicts(null),
    refresh,
  };
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
  const [drafting, setDrafting] = useState(false);
  // On this computer the title and description can be edited first; the cloud opens it straight away.
  const open = (asDraft = false) => (mode === "local" ? setDrafting(true) : void git.openPullRequest(asDraft));
  const main = pr
    ? { label: "View pull request", icon: <ExternalLink aria-hidden="true" className="size-3.5" />, run: () => void openExternal(pr.url) }
    : { label: "Open pull request", icon: <GitPullRequest aria-hidden="true" className="size-3.5" />, run: () => open() };
  const disabled = git.busy !== null || (mode === "local" && !canPush && !pr);
  const behind = s?.behind ?? 0;
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
          {git.busy === "push" || git.busy === "update" ? <Spinner /> : <ChevronDown aria-hidden="true" className="size-3.5" />}
        </BaseMenu.Trigger>
        <BaseMenu.Portal>
          <BaseMenu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <BaseMenu.Popup className="z-50 min-w-[14rem] origin-(--transform-origin) rounded-[10px] border border-line bg-paper p-1 text-[14px] text-ink shadow-pop outline-none transition-[opacity,scale] duration-150 ease-(--ease-out) data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
              <MenuItem icon={<ArrowUpFromLine />} disabled={!canPush || Boolean(git.pushProblem)} onSelect={() => void git.push()}>
                {s && s.pushed && s.unpushed === 0 ? "Push branch (up to date)" : "Push branch"}
              </MenuItem>
              {s && (
                <MenuItem icon={<ArrowDownToLine />} disabled={behind === 0} onSelect={() => void git.updateFromBase()}>
                  {behind > 0 ? `Update from ${s.baseBranch} (${behind} behind)` : `Up to date with ${s.baseBranch}`}
                </MenuItem>
              )}
              {pr ? (
                <MenuItem icon={<ExternalLink />} onSelect={() => void openExternal(pr.url)}>
                  View pull request
                </MenuItem>
              ) : (
                <>
                  <MenuItem icon={<GitPullRequest />} disabled={mode === "local" && !canPush} onSelect={() => open()}>
                    Open pull request
                  </MenuItem>
                  {mode === "local" && s?.gh === "ready" && (
                    <MenuItem icon={<GitPullRequestDraft />} disabled={!canPush} onSelect={() => open(true)}>
                      Open draft pull request
                    </MenuItem>
                  )}
                </>
              )}
              {mode === "local" && s && s.gh !== "ready" && !pr && (
                <>
                  <MenuSeparator />
                  <p className="px-2.5 py-1.5 text-[13px] leading-snug text-ink-faint">
                    {s.gh === "signed_out"
                      ? "Sign the GitHub CLI in (gh auth login) to open pull requests from here. Until then GitHub opens in your browser."
                      : "Without the GitHub CLI, GitHub opens in your browser to finish the pull request."}
                  </p>
                </>
              )}
              {git.pushProblem && (
                <>
                  <MenuSeparator />
                  <p className="max-w-[18rem] px-2.5 py-1.5 text-[13px] leading-snug text-ink-faint">{git.pushProblem}</p>
                </>
              )}
            </BaseMenu.Popup>
          </BaseMenu.Positioner>
        </BaseMenu.Portal>
      </BaseMenu.Root>
      <span className="sr-only" aria-live="polite">
        {git.busy === "push"
          ? "Pushing the branch"
          : git.busy === "pr"
            ? "Opening a pull request"
            : git.busy === "update"
              ? `Updating from ${s?.baseBranch ?? "the base branch"}`
              : ""}
      </span>
      {mode === "local" && (
        <PullRequestDraftDialog
          open={drafting}
          load={git.loadDraft}
          canDraft={s?.gh === "ready"}
          onClose={() => setDrafting(false)}
          onOpen={async (text, asDraft) => {
            if (await git.openPullRequest(asDraft, text)) setDrafting(false);
          }}
        />
      )}
    </div>
  );
}

/** A quiet line above the composer: what's changed on the branch, how far behind it is, and its pull request. */
export function GitStrip({
  git,
  onOpenChanges,
  onAsk,
  onTidy,
}: {
  git: GitState;
  onOpenChanges: () => void;
  /** Send the agent a message (to sort out merge conflicts). */
  onAsk?: (text: string) => void;
  /** Archive the thread and remove its worktree, once its pull request is merged. */
  onTidy?: () => Promise<void>;
}) {
  const s = git.status;
  const pr = git.pullRequest;
  const [tidying, setTidying] = useState(false);
  if (!s && !pr) return null;
  const chip =
    "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 text-[13px] font-medium text-ink-soft hover:border-line-strong hover:text-ink disabled:pointer-events-none disabled:opacity-50";
  const behind = s?.behind ?? 0;
  const merged = pr?.state === "merged";
  // Only when nothing would be lost: no uncommitted work in the thread's folder.
  const canTidy = Boolean(onTidy && merged && s && s.uncommittedFiles === 0);
  return (
    <div className="mb-2 space-y-2">
      {git.conflicts && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-lemon-line bg-lemon-soft px-3 py-2 text-[14px]">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
          <p className="min-w-0 flex-1 text-pretty">
            {git.conflicts.base} changed the same lines as this branch
            {git.conflicts.files.length ? ` in ${conflictList(git.conflicts.files)}` : ""}, so nothing was merged.
          </p>
          {onAsk && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onAsk(conflictsPrompt(git.conflicts!.base, git.conflicts!.files));
                git.clearConflicts();
              }}
            >
              Ask the agent to fix the conflicts
            </Button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={git.clearConflicts}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-faint hover:bg-cream-hover hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
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
        {s && behind > 0 && !merged && (
          <Tip label={`Merge the latest from ${s.baseBranch} into this branch, when it merges cleanly`}>
            <button type="button" onClick={() => void git.updateFromBase()} disabled={git.busy !== null} className={chip}>
              {git.busy === "update" ? <Spinner /> : <ArrowDownToLine aria-hidden="true" className="size-3.5" />}
              <span className="tabular-nums">
                {behind} behind {s.baseBranch}
              </span>
              <span className="border-l border-line pl-1.5 text-ink">Update</span>
            </button>
          </Tip>
        )}
        {pr && <PullRequestPill pr={pr} />}
        {pr && pr.state === "open" && git.watch && (
          <WatchToggle watch={git.watch} busy={git.busy === "watch"} disabled={git.busy !== null} onChange={on => void git.setWatch(on)} />
        )}
        {canTidy && (
          <button
            type="button"
            disabled={tidying}
            onClick={() => {
              setTidying(true);
              void onTidy!().finally(() => setTidying(false));
            }}
            className={chip}
          >
            {tidying ? <Spinner /> : <Archive aria-hidden="true" className="size-3.5" />}
            Archive thread and remove its worktree
          </button>
        )}
      </div>
    </div>
  );
}

function conflictList(files: string[]): string {
  if (files.length <= 3) return files.join(", ");
  return `${files.slice(0, 2).join(", ")} and ${files.length - 2} more files`;
}

/** Watching the pull request: when on, the agent is woken by failing checks, new comments and merge conflicts. */
function WatchToggle({ watch, busy, disabled, onChange }: { watch: PullRequestWatchState; busy: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const left = watch.maxCommentWakes - watch.commentWakes;
  const tip = watch.on
    ? `The agent gets a message when checks fail, new comments arrive or the branch has merge conflicts. ${left > 0 ? `Comments alone can wake it ${left} more ${left === 1 ? "time" : "times"}.` : "Comments alone no longer wake it."}`
    : "Wake the agent when checks fail, new comments arrive or the branch has merge conflicts.";
  return (
    <Tip label={tip}>
      <button
        type="button"
        aria-pressed={watch.on}
        disabled={disabled}
        onClick={() => onChange(!watch.on)}
        className={cx(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50",
          watch.on ? "border-[#c9e89a] bg-lime-soft text-leaf-deep" : "border-line bg-paper text-ink-soft hover:border-line-strong hover:text-ink",
        )}
      >
        {busy ? <Spinner /> : watch.on ? <Bell aria-hidden="true" className="size-3.5" /> : <BellOff aria-hidden="true" className="size-3.5" />}
        {watch.on ? "Watching" : "Watch"}
      </button>
    </Tip>
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
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium whitespace-nowrap hover:brightness-[0.98]",
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
