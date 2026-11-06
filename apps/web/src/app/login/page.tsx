import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo.tsx";
import { getUser, safeNext } from "@/lib/auth.ts";
import { SIGN_IN_CODE_LENGTH, githubEnabled } from "@/lib/better-auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/** Errors Better Auth can send back to this page after a GitHub sign-in. */
function errorMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "access_denied":
      return "GitHub sign-in was cancelled.";
    case "email_not_found":
      return "Your GitHub account has no public or verified email address.";
    default:
      return `Sign-in did not finish (${code.replace(/[^\w.-]/g, "").slice(0, 60)}). Please try again.`;
  }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  const ctx = await getAppContext();
  if (await getUser(ctx)) redirect(next);
  const error = errorMessage(typeof params.error === "string" ? params.error : null);
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-10 text-3xl font-semibold">Sign in</h1>
        <p className="mt-2 text-muted">Your coding agents keep working after you close your laptop.</p>
        <LoginForm github={githubEnabled(ctx.vars)} error={error} next={next} codeLength={SIGN_IN_CODE_LENGTH} />
      </div>
    </main>
  );
}
