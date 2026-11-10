import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, X } from "lucide-react";
import type { LoginUpdate } from "../lib/useThreadSession.ts";
import { Button, Spinner, TextInput, openExternal } from "./ui.tsx";

/**
 * The sign-in link to offer, or null if it isn't a secure web link. The link comes from the
 * sandbox, so it is only opened when it can't be anything but an ordinary https page.
 */
export function secureLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Sign a cloud thread's agent in to the user's own account, inside the sandbox: open the
 * page, approve, paste back the code. Nothing here is recorded in the thread, and the next
 * cloud threads with this agent start signed in.
 */
export function SignInPanel({
  agentLabel,
  login,
  onClose,
}: {
  agentLabel: string;
  login: { update: LoginUpdate | null; start: () => void; input: (text: string) => void; cancel: () => void };
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const u = login.update;
  const link = secureLink(u?.url);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    login.input(code.trim());
    setCode("");
    setSent(true);
  };
  return (
    <section aria-labelledby="sign-in-heading" className="mx-auto my-4 w-full max-w-[760px] rounded-2xl border border-line bg-paper p-5 shadow-panel">
      <div className="flex items-start gap-3">
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-leaf" />
        <h2 id="sign-in-heading" className="flex-1 font-sans text-[15px] font-semibold tracking-normal">
          Sign {agentLabel} in to your account
        </h2>
        <button
          type="button"
          aria-label="Close sign-in"
          onClick={() => {
            if (u && u.state !== "done" && u.state !== "failed") login.cancel();
            onClose();
          }}
          className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {!u || u.state === "failed" ? (
        <div className="mt-2 space-y-3 pl-7 text-[14px]">
          {u?.state === "failed" && <p className="text-danger">{u.message ?? "Sign-in didn't finish."}</p>}
          <p className="text-ink-soft">The cloud agent uses your own plan. You sign in once; later cloud threads with {agentLabel} start signed in.</p>
          <Button variant="primary" size="sm" onClick={login.start}>
            {u?.state === "failed" ? "Try again" : "Start sign-in"}
          </Button>
        </div>
      ) : u.state === "done" ? (
        <p className="mt-2 pl-7 text-[14px] text-leaf">{u.message ?? "Signed in. Send your message again."}</p>
      ) : (
        <div className="mt-3 space-y-3 pl-7 text-[14px]">
          {u.state === "starting" && (
            <p className="flex items-center gap-2 text-ink-soft">
              <Spinner /> Starting sign-in in the sandbox…
            </p>
          )}
          {u.url && !link && <p className="text-danger">The sandbox sent a sign-in link that isn't safe to open. Close this and try again.</p>}
          {link && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => void openExternal(link)}>
                <ExternalLink aria-hidden="true" className="size-3.5" />
                Open the sign-in page
              </Button>
              {u.code && (
                <span className="text-ink-soft">
                  and enter <code className="rounded bg-cream-deep px-1.5 py-0.5 font-mono text-ink">{u.code}</code>
                </span>
              )}
            </div>
          )}
          {u.state === "needs_input" && (
            <form onSubmit={submit} className="flex flex-wrap items-center gap-2" autoComplete="off">
              <TextInput
                aria-label="Code from the sign-in page"
                placeholder="Paste the code the page shows"
                value={code}
                onChange={e => setCode(e.target.value)}
                className="min-w-56 flex-1 font-mono text-[13px]"
                spellCheck={false}
              />
              <Button type="submit" size="sm" variant="primary" disabled={!code.trim()}>
                {sent ? "Checking…" : "Continue"}
              </Button>
            </form>
          )}
          {u.state === "open_url" && u.code && <p className="text-ink-soft">Waiting for you to finish on the sign-in page…</p>}
        </div>
      )}
    </section>
  );
}
