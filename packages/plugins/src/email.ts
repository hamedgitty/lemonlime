/**
 * The one email layout every LemonLime email uses: the control plane's own (sign-in codes,
 * invites) and any a deployment plugin sends. Give it content; it returns matching HTML and
 * plain-text versions.
 *
 * Built for email clients, not browsers: tables for layout, inline styles, no scripts, a
 * hidden preview line, a bulletproof button, and images that are only ever decoration.
 */

export interface EmailBrand {
  /** Shown as the sender's product name, e.g. "LemonLime". */
  name: string;
  /** Where the logo and footer link go, e.g. "https://app.example.com". */
  appUrl: string;
  /** An absolute URL to a wide logo image (PNG, about 4:1), shown at 140px wide. */
  logoUrl: string;
  /** Where people can write for help. Leave out to say nothing about support. */
  supportEmail?: string;
  /** Small links in the footer. */
  links?: { label: string; url: string }[];
}

export interface EmailDetail {
  label: string;
  value: string;
  /** A total or other line that should stand out. */
  strong?: boolean;
}

export interface EmailContent {
  /** The subject line. */
  subject: string;
  /** The line inboxes show next to the subject. Never shown in the email itself. */
  preview: string;
  /** The big heading. */
  title: string;
  /** An optional picture under the logo: an absolute URL to a 1040×400 PNG. Decorative. */
  art?: string;
  /** Paragraphs before the code, details and button. Plain text; `**bold**` and `[label](https://…)` are allowed. */
  intro: string[];
  /** A one-time code, shown large. */
  code?: string;
  /** Label and value rows, like a receipt. */
  details?: EmailDetail[];
  /** The one main action. */
  button?: { label: string; url: string };
  /** Paragraphs after the button. */
  outro?: string[];
  /** A small, quiet line at the end of the card, e.g. "If this wasn't you, ignore it." */
  note?: string;
  /** Why the person got this email, shown in the footer. */
  reason?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const C = {
  page: "#FFFBEA",
  card: "#FFFFFF",
  line: "#EDE6C4",
  ink: "#17200E",
  ink2: "#3A4530",
  ink3: "#636D54",
  tile: "#FFF6CF",
  tileLine: "#F3E08A",
  lemon: "#FFD60A",
  lemonEdge: "#E9C300",
  leaf: "#3F7A16",
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = `'Bricolage Grotesque',${SANS}`;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escape, then turn `**bold**` into <strong> and `[label](https://…)` into a link. */
const inline = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C.ink};font-weight:600">$1</strong>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, `<a href="$2" style="color:${C.leaf};text-decoration:underline">$1</a>`);
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");

function paragraphs(list: string[] | undefined, top = 0): string {
  return (list ?? []).map((p, i) => `<p style="margin:${i === 0 ? top : 14}px 0 0;font:400 16px/1.6 ${SANS};color:${C.ink2}">${inline(p)}</p>`).join("");
}

function codeTile(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td align="center" style="background:${C.tile};border:1px solid ${C.tileLine};border-radius:16px;padding:22px 12px">
<span style="font:700 34px/1 ${MONO};letter-spacing:10px;color:${C.ink};padding-left:10px">${esc(code)}</span>
</td></tr></table>`;
}

function detailRows(rows: EmailDetail[]): string {
  const cells = rows
    .map(
      (r, i) => `<tr>
<td style="padding:12px 0;border-top:1px solid ${i === 0 ? C.ink : C.line};font:${r.strong ? 600 : 400} ${r.strong ? 17 : 15}px/1.4 ${SANS};color:${r.strong ? C.ink : C.ink3}">${inline(r.label)}</td>
<td align="right" style="padding:12px 0 12px 16px;border-top:1px solid ${i === 0 ? C.ink : C.line};font:${r.strong ? 700 : 500} ${r.strong ? 17 : 15}px/1.4 ${SANS};color:${C.ink};white-space:nowrap">${inline(r.value)}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-collapse:collapse;border-bottom:1px solid ${C.line}">${cells}</table>`;
}

/** A button that keeps its shape in every client, Outlook included. */
function button(b: { label: string; url: string }): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px"><tr>
<td align="center" bgcolor="${C.lemon}" style="background:${C.lemon};border:1px solid ${C.lemonEdge};border-radius:999px">
<a href="${esc(b.url)}" style="display:inline-block;padding:14px 28px;font:600 16px/1 ${SANS};color:${C.ink};text-decoration:none;border-radius:999px">${esc(b.label)}</a>
</td></tr></table>`;
}

export function renderEmail(content: EmailContent, brand: EmailBrand): RenderedEmail {
  const art = content.art
    ? `<tr><td class="pad" style="padding:28px 40px 0"><img src="${esc(content.art)}" width="480" alt="" style="display:block;width:100%;max-width:480px;height:auto;border:0;border-radius:16px"></td></tr>`
    : "";
  const help = brand.supportEmail
    ? `<p style="margin:${content.note ? 10 : 0}px 0 0;font:400 14px/1.6 ${SANS};color:${C.ink3}">Questions? Write to <a href="mailto:${esc(brand.supportEmail)}" style="color:${C.leaf};text-decoration:underline">${esc(brand.supportEmail)}</a> and a person will answer.</p>`
    : "";
  const note = content.note ? `<p style="margin:0;font:400 14px/1.6 ${SANS};color:${C.ink3}">${inline(content.note)}</p>` : "";
  const quiet =
    help || note
      ? `<tr><td class="pad" style="padding:28px 40px 36px"><div style="border-top:1px solid ${C.line};padding-top:20px">${note}${help}</div></td></tr>`
      : `<tr><td style="padding:0 0 36px"></td></tr>`;
  const links = (brand.links ?? []).map(l => `<a href="${esc(l.url)}" style="color:${C.ink3};text-decoration:none;margin:0 10px">${esc(l.label)}</a>`).join("");

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(content.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
  a { color:${C.leaf}; }
  @media (max-width:600px) {
    .pad { padding-left:24px !important; padding-right:24px !important; }
    .title { font-size:27px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(content.preview)}${"&#8199;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:32px 12px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.line};border-radius:24px">
<tr><td class="pad" style="padding:36px 40px 0"><a href="${esc(brand.appUrl)}"><img src="${esc(brand.logoUrl)}" width="140" height="26" alt="${esc(brand.name)}" style="display:block;border:0;width:140px;height:auto"></a></td></tr>
${art}
<tr><td class="pad" style="padding:32px 40px 0">
<h1 class="title" style="margin:0;font:700 30px/1.15 ${DISPLAY};letter-spacing:-0.02em;color:${C.ink}">${esc(content.title)}</h1>
${paragraphs(content.intro, 14)}
${content.code ? codeTile(content.code) : ""}
${content.details?.length ? detailRows(content.details) : ""}
${content.button ? button(content.button) : ""}
${paragraphs(content.outro, 24)}
</td></tr>
${quiet}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td align="center" style="padding:24px 24px 0;font:400 13px/1.7 ${SANS};color:${C.ink3}">
${links ? `<p style="margin:0 0 8px">${links}</p>` : ""}${content.reason ? `<p style="margin:0">${inline(content.reason)}</p>` : ""}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    content.title,
    "",
    ...content.intro.map(plain).flatMap(p => [p, ""]),
    ...(content.code ? [content.code, ""] : []),
    ...(content.details ?? []).map(d => `${plain(d.label)}: ${plain(d.value)}`),
    ...(content.details?.length ? [""] : []),
    ...(content.button ? [`${content.button.label}: ${content.button.url}`, ""] : []),
    ...(content.outro ?? []).map(plain).flatMap(p => [p, ""]),
    ...(content.note ? [plain(content.note)] : []),
    ...(brand.supportEmail ? [`Questions? Write to ${brand.supportEmail} and a person will answer.`] : []),
    "",
    "--",
    brand.name,
    ...(content.reason ? [plain(content.reason)] : []),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { subject: content.subject, html, text: `${text}\n` };
}
