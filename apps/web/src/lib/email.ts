/**
 * Outgoing email. Every message is laid out by `renderEmail` from @lemonlime/plugins. Picks a transport from the environment:
 *
 * 1. Cloudflare Email Service, when the Worker has a `send_email` binding named `EMAIL`.
 * 2. Resend's HTTP API, when `RESEND_API_KEY` is set.
 * 3. Otherwise, in development only, the message is printed to the server console.
 *    In production, sending fails with a message that says what to configure.
 *
 * The sender address comes from `LEMONLIME_EMAIL_FROM`, e.g. `LemonLime <sign-in@example.com>`.
 */

import { renderEmail, type EmailBrand } from "@lemonlime/plugins";

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

/** This deployment's name, logo and links for its emails. The logo is served by the app itself. */
export function emailBrand(publicUrl: string, supportEmail?: string): EmailBrand {
  return {
    name: "LemonLime",
    appUrl: publicUrl,
    logoUrl: `${publicUrl}/email/lemonlime.png`,
    ...(supportEmail?.trim() ? { supportEmail: supportEmail.trim() } : {}),
    links: [
      { label: "Dashboard", url: publicUrl },
      { label: "Docs", url: "https://lemonlime.dev/docs/" },
    ],
  };
}

/** The sign-in code email. */
export function signInCodeEmail(brand: EmailBrand, to: string, code: string, minutes: number): EmailMessage {
  return {
    to,
    ...renderEmail(
      {
        subject: `${code} is your ${brand.name} sign-in code`,
        preview: `Enter it within ${minutes} minutes to finish signing in.`,
        title: "Your sign-in code",
        intro: [`Enter this code in ${brand.name} to finish signing in.`],
        code,
        note: `It expires in ${minutes} minutes. If you didn't try to sign in, you can ignore this email: nobody gets in without the code.`,
        reason: `You're getting this because someone asked to sign in to ${brand.name} with this address.`,
      },
      brand,
    ),
  };
}

/** The invitation to join a workspace. */
export function inviteEmail(brand: EmailBrand, o: { to: string; inviter: string; workspace: string; link: string; days: number }): EmailMessage {
  return {
    to: o.to,
    ...renderEmail(
      {
        subject: `${o.inviter} invited you to ${o.workspace} on ${brand.name}`,
        preview: `Join the workspace to share coding agent threads with ${o.inviter}.`,
        title: `Join ${o.workspace}`,
        intro: [
          `**${o.inviter}** invited you to the **${o.workspace}** workspace on ${brand.name}, where your team runs coding agents and shares their threads.`,
        ],
        button: { label: "Accept the invitation", url: o.link },
        note: `The link works for ${o.days} days, and only for ${o.to}. If you weren't expecting this, you can ignore it.`,
        reason: `You're getting this because someone in a ${brand.name} workspace invited this address.`,
      },
      brand,
    ),
  };
}
