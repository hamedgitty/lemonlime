import { useEffect, useId, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { GitBranch, GitFork, X } from "lucide-react";
import type { PullRequestDraft } from "@lemonlime/protocol";
import { Button, IconButton, Spinner, TextInput, cx, inputClass } from "./ui.tsx";

/** A small centred dialog in the app's look: title, body, and its own close button. */
function DialogFrame({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={o => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim/40 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cx(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-paper text-ink shadow-pop outline-none transition-[opacity,scale] duration-200 ease-(--ease-out) data-[ending-style]:scale-[0.99] data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0",
            wide ? "max-w-[620px]" : "max-w-[440px]",
          )}
        >
          <div className="flex items-center gap-2 px-5 pt-4 pb-2">
            <Dialog.Title className="min-w-0 flex-1 text-[16px] font-semibold text-balance">{title}</Dialog.Title>
            <Dialog.Close
              render={
                <IconButton label="Close">
                  <X aria-hidden="true" className="size-4" />
                </IconButton>
              }
            />
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Forking: whether the new thread keeps this thread's code at that point, or starts fresh from the base. */
export function ForkDialog({
  open,
  branch,
  baseBranch,
  latest,
  onFork,
  onClose,
}: {
  open: boolean;
  branch: string;
  baseBranch: string;
  /** The fork is from the latest message, so "that point" is the branch as it is now. */
  latest: boolean;
  onFork: (withCode: boolean) => void;
  onClose: () => void;
}) {
  const [withCode, setWithCode] = useState(true);
  useEffect(() => {
    if (open) setWithCode(true);
  }, [open]);
  const name = useId();
  const option = (value: boolean, icon: ReactNode, label: string, detail: ReactNode) => (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 has-[:focus-visible]:border-leaf",
        withCode === value ? "border-line-strong bg-cream-deep" : "border-line hover:bg-cream",
      )}
    >
      <input type="radio" name={name} checked={withCode === value} onChange={() => setWithCode(value)} className="mt-1 accent-[var(--color-leaf)]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[14px] font-medium [&_svg]:size-4 [&_svg]:text-ink-soft">
          {icon}
          {label}
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-pretty text-ink-soft">{detail}</span>
      </span>
    </label>
  );
  return (
    <DialogFrame open={open} onClose={onClose} title="Fork into a new thread">
      <form
        className="space-y-2.5 px-5 pt-1 pb-5"
        onSubmit={e => {
          e.preventDefault();
          onFork(withCode);
        }}
      >
        <p className="text-[14px] text-pretty text-ink-soft">The new thread gets its own branch. Which code should it start with?</p>
        {option(
          true,
          <GitFork aria-hidden="true" />,
          "This thread's code",
          <>
            {latest ? "Everything on " : "What was on "}
            <span className="font-mono text-[12px]">{branch}</span>
            {latest ? " now." : " at that message."}
          </>,
        )}
        {option(
          false,
          <GitBranch aria-hidden="true" />,
          `Fresh from ${baseBranch}`,
          <>
            Without this thread's changes. They stay on <span className="font-mono text-[12px]">{branch}</span>.
          </>,
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit">
            Fork
          </Button>
        </div>
      </form>
    </DialogFrame>
  );
}

/** Opening a pull request: an editable title and description, drafted from the thread's commits. */
export function PullRequestDraftDialog({
  open,
  load,
  canDraft,
  onClose,
  onOpen,
}: {
  open: boolean;
  load: () => Promise<PullRequestDraft>;
  /** gh can open drafts here. */
  canDraft: boolean;
  onClose: () => void;
  onOpen: (draft: PullRequestDraft, asDraft: boolean) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "opening">("loading");
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState("loading");
    setError(null);
    load()
      .then(d => {
        if (cancelled) return;
        setTitle(d.title);
        setBody(d.body);
      })
      .catch(err => !cancelled && setError(`Couldn't write a draft, so start from scratch. ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => !cancelled && setState("ready"));
    return () => {
      cancelled = true;
    };
    // `load` changes every render; a new draft is only wanted when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = async (asDraft: boolean) => {
    if (!title.trim() || state !== "ready") return;
    setState("opening");
    try {
      await onOpen({ title: title.trim(), body }, asDraft);
    } finally {
      setState("ready");
    }
  };
  return (
    <DialogFrame open={open} onClose={onClose} title="Open a pull request" wide>
      <form
        className="flex min-h-0 flex-col gap-3 px-5 pt-1 pb-5"
        onSubmit={e => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <p className="text-[14px] text-pretty text-ink-soft">
          Written from the thread's first message and its commits. Change anything before it goes to GitHub.
        </p>
        {error && <p className="rounded-lg border border-lemon-line bg-lemon-soft px-3 py-2 text-[13px]">{error}</p>}
        <div>
          <label htmlFor={titleId} className="mb-1 block text-[13px] font-medium">
            Title
          </label>
          <TextInput id={titleId} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} disabled={state === "loading"} autoFocus />
        </div>
        <div className="flex min-h-0 flex-col">
          <label htmlFor={bodyId} className="mb-1 block text-[13px] font-medium">
            Description
          </label>
          <textarea
            id={bodyId}
            value={body}
            onChange={e => setBody(e.target.value)}
            maxLength={60_000}
            rows={12}
            disabled={state === "loading"}
            className={cx(inputClass, "scroll-thin min-h-[160px] resize-y font-mono text-[13px] leading-relaxed")}
          />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          {state === "loading" && (
            <span className="mr-auto inline-flex items-center gap-2 text-[13px] text-ink-faint">
              <Spinner /> Drafting…
            </span>
          )}
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          {canDraft && (
            <Button size="sm" disabled={!title.trim() || state !== "ready"} onClick={() => void submit(true)}>
              Open as draft
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit" disabled={!title.trim() || state !== "ready"}>
            {state === "opening" && <Spinner />}
            Open pull request
          </Button>
        </div>
      </form>
    </DialogFrame>
  );
}
