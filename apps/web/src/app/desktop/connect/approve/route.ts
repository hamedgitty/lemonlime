import { requireUser } from "@/lib/auth.ts";
import { approveDesktop, isFromOwnForm, NOT_THIS_SITES_FORM } from "@/lib/desktop-connect.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Creates a token for the desktop app and sends it back through the app's own
 * lemonlime:// link. Only a signed-in browser session can do this, only from this site's
 * own form, only once for each link the app opened, and the token never goes to any other address.
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  if (!isFromOwnForm(request, ctx.config.publicUrl())) throw new HttpError(403, NOT_THIS_SITES_FORM);
  const user = await requireUser(ctx, request);
  if (user.via !== "session") throw new HttpError(403, "Connect the desktop app from the web dashboard.");
  // Anything that isn't this site's form is the same as a form with no state.
  const form = await request.formData().catch(() => null);
  const { link } = await approveDesktop(ctx, user.userId, String(form?.get("state") ?? ""));

  // The page's one script carries this request's one-time value (src/proxy.ts), so the
  // page's script policy lets it run.
  const nonce = request.headers.get("x-nonce") ?? "";
  const script = /^[A-Za-z0-9+/=]+$/.test(nonce) ? `<script nonce="${nonce}">` : "<script>";

  // A page rather than a bare redirect: browsers ask before opening an app, and the link
  // stays clickable if that prompt was dismissed.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Opening LemonLime</title>
<style>body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#fffbea;color:#17200e;font:16px/1.55 Inter,-apple-system,system-ui,sans-serif}main{max-width:420px;padding:28px;background:#fff;border:1px solid #e9e3c4;border-radius:16px}a.btn{display:inline-block;margin-top:16px;background:#ffe135;color:#17200e;padding:10px 18px;border-radius:10px;font-weight:600;text-decoration:none}p{color:#5d6651}</style></head>
<body><main><h1 style="margin:0;font-size:22px">Connected</h1><p>Switching back to the LemonLime app. If nothing happens, open it with the button.</p><a class="btn" href="${esc(link)}">Open LemonLime</a></main>
${script}location.href=${JSON.stringify(link)}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
});
