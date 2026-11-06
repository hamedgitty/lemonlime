"use client";

import { useState, type FormEvent } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser.ts";

function callbackUrl(next: string): string {
  const url = new URL("/auth/callback", window.location.origin);
  if (next !== "/") url.searchParams.set("next", next);
  return url.toString();
}

export function LoginForm({ github, error, next }: { github: boolean; error: string | null; next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [message, setMessage] = useState<string | null>(error);

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    setMessage(null);
    const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl(next) },
    });
    if (error) {
      setState("idle");
      setMessage(error.message);
    } else setState("sent");
  }

  async function signInWithGitHub() {
    setMessage(null);
    const { error } = await createSupabaseBrowserClient().auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: callbackUrl(next) },
    });
    if (error) setMessage(error.message);
  }

  if (state === "sent") {
    return (
      <div className="card mt-8 p-5" role="status">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="mt-1 text-sm text-muted">
          We sent a sign-in link to <span className="font-medium text-ink">{email}</span>. Open it on this device.
        </p>
        <button type="button" className="mt-4 text-sm font-medium text-leaf hover:underline" onClick={() => setState("idle")}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-4">
      {message && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {message}
        </p>
      )}
      <form onSubmit={sendLink} className="space-y-3">
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="field"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={state === "sending"}>
          {state === "sending" ? "Sending link..." : "Email me a sign-in link"}
        </button>
      </form>
      {github && (
        <>
          <div className="flex items-center gap-3 text-sm text-muted">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <button type="button" className="btn-ghost w-full" onClick={signInWithGitHub}>
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Continue with GitHub
          </button>
        </>
      )}
    </div>
  );
}
