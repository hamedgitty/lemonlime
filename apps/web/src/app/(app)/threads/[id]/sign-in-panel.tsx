"use client";

import { useState, type FormEvent } from "react";
import { safeLink } from "@/lib/links.ts";

export interface LoginUpdate {
  state: "starting" | "open_url" | "needs_input" | "done" | "failed";
  url?: string;
  code?: string;
  message?: string;
}

/**
 * Signs the thread's agent in to the person's own account, inside the sandbox: open the
 * link, approve, paste back the code. None of this is recorded in the thread.
 */
export function SignInPanel({
  agentLabel,
  update,
  onStart,
  onCode,
  onClose,
}: {
  agentLabel: string;
  update: LoginUpdate | null;
  onStart: () => void;
  onCode: (code: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    onCode(code.trim());
    setCode("");
    setSent(true);
  };
  const state = update?.state;
  // The link comes from the sandbox, so it is only offered when it is an ordinary web page.
  const link = safeLink(update?.url);
  return (
    <section aria-labelledby="sign-in-heading" className="card my-6 p-5">
      <div className="flex items-start justify-between gap-4">
        <h2 id="sign-in-heading" className="font-semibold">
          Sign {agentLabel} in to your account
        </h2>
        <button type="button" className="text-sm text-muted hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      {!update || state === "failed" ? (
        <div className="mt-2 space-y-3 text-sm">
          {state === "failed" && <p className="text-red-800">{update?.message ?? "Sign-in didn't finish."}</p>}
          <p className="text-muted">
            You sign in once; your next cloud threads with {agentLabel} start signed in. Nothing you enter here is saved in the thread.
          </p>
          <button type="button" className="btn-primary h-9" onClick={onStart}>
            {state === "failed" ? "Try again" : "Start sign-in"}
          </button>
        </div>
      ) : state === "done" ? (
        <p className="mt-2 text-sm">{update.message ?? "Signed in."}</p>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          {state === "starting" && <p className="text-muted">Starting sign-in in the sandbox...</p>}
          {update.url && !link && <p className="text-red-800">The sandbox sent a sign-in link that isn&apos;t safe to open. Close this and try again.</p>}
          {link && (
            <p>
              1.{" "}
              <a href={link} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
                Open the sign-in page
              </a>{" "}
              and approve LemonLime.
              {update.code && (
                <>
                  {" "}
                  When it asks for a code, enter <code className="rounded bg-cream px-1.5 py-0.5 font-mono">{update.code}</code>.
                </>
              )}
            </p>
          )}
          {state === "needs_input" && (
            <form onSubmit={submit} className="flex flex-wrap items-end gap-2" autoComplete="off">
              <div className="min-w-56 flex-1">
                <label htmlFor="sign-in-code" className="label">
                  2. Paste the code the page shows you
                </label>
                <input id="sign-in-code" className="field font-mono" value={code} onChange={e => setCode(e.target.value)} spellCheck={false} />
              </div>
              <button type="submit" className="btn-primary h-10" disabled={!code.trim()}>
                {sent ? "Checking..." : "Continue"}
              </button>
            </form>
          )}
          {state === "open_url" && update.code && <p className="text-muted">Waiting for you to finish on the sign-in page...</p>}
        </div>
      )}
    </section>
  );
}
