/**
 * Outgoing email (sign-in codes). Picks a transport from the environment:
 *
 * 1. Cloudflare Email Service, when the Worker has a `send_email` binding named `EMAIL`.
 * 2. Resend's HTTP API, when `RESEND_API_KEY` is set.
 * 3. Otherwise, in development only, the message is printed to the server console.
 *    In production, sending fails with a message that says what to configure.
 *
 * The sender address comes from `LEMONLIME_EMAIL_FROM`, e.g. `LemonLime <sign-in@example.com>`.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  /** Short name for logs: "cloudflare", "resend" or "console". */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** The subset of Cloudflare's `send_email` binding this app uses (see `wrangler.jsonc`). */
export interface SendEmailBinding {
  send(message: { to: string | string[]; from: string | { email: string; name?: string }; subject: string; text?: string; html?: string }): Promise<unknown>;
}

export interface EmailEnv {
  vars: Record<string, string | undefined>;
  /** The `EMAIL` binding, if the Worker has one. */
  binding: SendEmailBinding | null;
  production: boolean;
  fetch?: typeof fetch;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Email is not configured. Add a send_email binding named EMAIL (Cloudflare) or set RESEND_API_KEY, " +
        "and set LEMONLIME_EMAIL_FROM. See docs/self-hosting.md.",
    );
  }
}

/** `Name <addr@host>` or `addr@host` → parts. */
export function parseAddress(value: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(value);
  if (m) {
    const name = m[1]!.replace(/^"(.*)"$/, "$1").trim();
    return name ? { email: m[2]!, name } : { email: m[2]! };
  }
  return { email: value.trim() };
}

function fromAddress(vars: EmailEnv["vars"]): string {
  const from = vars.LEMONLIME_EMAIL_FROM?.trim();
  if (!from) throw new Error("LEMONLIME_EMAIL_FROM is not set. See .env.example and docs/self-hosting.md.");
  return from;
}

export function cloudflareSender(binding: SendEmailBinding, from: string): EmailSender {
  return {
    name: "cloudflare",
    async send(m) {
      await binding.send({ to: m.to, from: parseAddress(from), subject: m.subject, text: m.text, html: m.html });
    },
  };
}

export function resendSender(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailSender {
  return {
    name: "resend",
    async send(m) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend refused the email (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }
    },
  };
}

/** Development only: print the message instead of sending it. */
export const consoleSender: EmailSender = {
  name: "console",
  async send(m) {
    console.info(`\n[lemonlime] Email to ${m.to} (not sent: no email transport configured)\nSubject: ${m.subject}\n\n${m.text}\n`);
  },
};

export function createEmailSender(env: EmailEnv): EmailSender {
  if (env.binding) return cloudflareSender(env.binding, fromAddress(env.vars));
  const resendKey = env.vars.RESEND_API_KEY?.trim();
  if (resendKey) return resendSender(resendKey, fromAddress(env.vars), env.fetch);
  if (!env.production) return consoleSender;
  return {
    name: "none",
    async send() {
      throw new EmailNotConfiguredError();
    },
  };
}

/** The sign-in code email. */
export function signInCodeEmail(to: string, code: string, minutes: number): EmailMessage {
  const subject = `${code} is your LemonLime sign-in code`;
  const text = [
    `Your LemonLime sign-in code is ${code}.`,
    "",
    `It expires in ${minutes} minutes. If you did not try to sign in, you can ignore this email.`,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#fffbea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17200e">
  <div style="max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #e9e3c4;border-radius:16px;padding:28px">
    <p style="margin:0 0 4px;font-size:15px;font-weight:600">LemonLime</p>
    <p style="margin:0 0 20px;font-size:15px;color:#5d6651">Your sign-in code:</p>
    <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,Menlo,monospace">${code}</p>
    <p style="margin:0;font-size:13px;color:#5d6651">It expires in ${minutes} minutes. If you did not try to sign in, you can ignore this email.</p>
  </div>
</body></html>`;
  return { to, subject, text, html };
}
