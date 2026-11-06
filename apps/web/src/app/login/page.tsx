import type { Metadata } from "next";
import { Logo } from "@/components/logo.tsx";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const next = typeof params.next === "string" ? params.next : "/";
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-10 text-3xl font-semibold">Sign in</h1>
        <p className="mt-2 text-muted">Your coding agents keep working after you close your laptop.</p>
        <LoginForm github={process.env.NEXT_PUBLIC_SUPABASE_GITHUB === "1"} error={error} next={next} />
      </div>
    </main>
  );
}
