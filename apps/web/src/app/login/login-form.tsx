"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client.ts";

const RESEND_AFTER_SECONDS = 30;

type AuthError = { code?: string | undefined; message?: string | undefined; status?: number | undefined } | null;

/** Friendly text for Better Auth's error codes. */
function describe(error: AuthError, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  switch (error.code) {
    case "INVALID_OTP":
      return "That code is not right. Check the email and try again.";
    case "OTP_EXPIRED":
      return "That code has expired. Send a new one.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many wrong codes. Send a new one.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    default:
      return error.message || fallback;
  }
}

export function LoginForm({ github, error, next, codeLength }: { github: boolean; error: string | null; next: string; codeLength: number }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | "github" | null>(null);
  const [message, setMessage] = useState<string | null>(error);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function sendCode(): Promise<boolean> {
    setBusy("send");
    setMessage(null);
    setNotice(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
    setBusy(null);
    if (error) {
      setMessage(describe(error, "Could not send the code. Please try again."));
      return false;
    }
    setCooldown(RESEND_AFTER_SECONDS);
    return true;
  }

  async function submitEmail(e: FormEvent) {
    e.preventDefault();
    if (await sendCode()) {
      setCode("");
      setStep("code");
    }
  }

  async function resend() {
    if (await sendCode()) {
      setCode("");
      setNotice("We sent a new code. Earlier codes no longer work.");
      codeRef.current?.focus();
    }
  }

  async function verify(value: string) {
    if (busy || value.length !== codeLength) return;
    setBusy("verify");
    setMessage(null);
    setNotice(null);
    const { error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: value });
    if (error) {
      setBusy(null);
      setMessage(describe(error, "Could not sign you in. Please try again."));
      setCode("");
      codeRef.current?.focus();
      return;
    }
    // Full navigation so server components see the new session cookie.
    window.location.assign(next);
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, codeLength);
    setCode(digits);
    if (digits.length === codeLength) void verify(digits);
  }

  async function signInWithGitHub() {
    setBusy("github");
    setMessage(null);
    const { error } = await authClient.signIn.social({ provider: "github", callbackURL: next, errorCallbackURL: "/login" });
    if (error) {
      setBusy(null);
      setMessage(describe(error, "Could not start GitHub sign-in."));
    }
  }

  const alert = message && (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );

  if (step === "code") {
    return (
      <div className="mt-8 space-y-4">
        <div className="card p-5">
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="mt-1 text-sm text-muted">
            We sent a {codeLength}-digit code to <span className="font-medium text-ink">{email.trim()}</span>. It expires in 10 minutes.
          </p>
          <form
            className="mt-4 space-y-3"
            onSubmit={e => {
              e.preventDefault();
              void verify(code);
            }}
          >
            <div>
              <label htmlFor="code" className="label">
                Sign-in code
              </label>
              <input
                ref={codeRef}
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern={`[0-9]{${codeLength}}`}
                maxLength={codeLength}
                required
                aria-describedby={message ? "code-error" : undefined}
                aria-invalid={message ? true : undefined}
                className="field text-center font-mono text-2xl tracking-[0.5em]"
                placeholder={"0".repeat(codeLength)}
                value={code}
                onChange={e => onCodeChange(e.target.value)}
                disabled={busy === "verify"}
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy !== null || code.length !== codeLength}>
              {busy === "verify" ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
        {message && (
          <p id="code-error" role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {message}
          </p>
        )}
        {notice && !message && (
          <p role="status" className="rounded-lg border border-lime bg-lime/15 px-3 py-2 text-sm">
            {notice}
          </p>
        )}
        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className="font-medium text-leaf hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
            onClick={resend}
            disabled={busy !== null || cooldown > 0}
          >
            {busy === "send" ? "Sending..." : cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
          </button>
          <button
            type="button"
            className="text-muted hover:text-ink"
            onClick={() => {
              setStep("email");
              setMessage(null);
              setNotice(null);
              setCode("");
            }}
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-4">
      {alert}
      <form onSubmit={submitEmail} className="space-y-3">
        <div>
          <label htmlFor="email" className="label">
            Email
          </label>
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
        <button type="submit" className="btn-primary w-full" disabled={busy !== null}>
          {busy === "send" ? "Sending code..." : "Email me a sign-in code"}
        </button>
      </form>
      {github && (
        <>
          <div className="flex items-center gap-3 text-sm text-muted">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <button type="button" className="btn-ghost w-full" onClick={signInWithGitHub} disabled={busy !== null}>
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {busy === "github" ? "Opening GitHub..." : "Continue with GitHub"}
          </button>
        </>
      )}
    </div>
  );
}
