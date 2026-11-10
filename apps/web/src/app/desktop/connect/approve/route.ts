import { createAccessTokenRow } from "@/lib/access.ts";
import { generateAccessToken, hashAccessToken } from "@/lib/access-tokens.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, route } from "@/lib/http.ts";
import { enforce, LIMITS } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Creates a token for the desktop app and sends it back through the app's own
 * lemonlime:// link. Only a signed-in browser session can do this, only from this site's
 * own form, and the token never goes to any other address.
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const publicUrl = ctx.config.publicUrl();
  // Same-site form posts only.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(publicUrl).origin) throw new HttpError(403, "This request didn't come from this site.");
  const user = await requireUser(ctx, request);
  if (user.via !== "session") throw new HttpError(403, "Connect the desktop app from the web dashboard.");
  // Anything that isn't this site's form is the same as a form with no state.
  const form = await request.formData().catch(() => null);
  const state = String(form?.get("state") ?? "");
  if (!STATE.test(state)) throw new HttpError(400, "That sign-in link is not valid. Start again from the app.");
  await enforce(ctx.db, `tokens:${user.userId}`, LIMITS.tokensPerUser, "new tokens");

  const raw = generateAccessToken();
  const day = new Date().toISOString().slice(0, 10);
  await createAccessTokenRow(ctx.db, user.userId, `Desktop app (${day})`, hashAccessToken(raw));
  const link = `lemonlime://auth?${new URLSearchParams({ token: raw, state, url: publicUrl }).toString()}`;

  // A page rather than a bare redirect: browsers ask before opening an app, and the link
  // stays clickable if that prompt was dismissed.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Opening LemonLime</title>
<style>body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#fffbea;color:#17200e;font:16px/1.55 Inter,-apple-system,system-ui,sans-serif}main{max-width:420px;padding:28px;background:#fff;border:1px solid #e9e3c4;border-radius:16px}a.btn{display:inline-block;margin-top:16px;background:#ffe135;color:#17200e;padding:10px 18px;border-radius:10px;font-weight:600;text-decoration:none}p{color:#5d6651}</style></head>
<body><main><h1 style="margin:0;font-size:22px">Connected</h1><p>Switching back to the LemonLime app. If nothing happens, open it with the button.</p><a class="btn" href="${esc(link)}">Open LemonLime</a></main>
<script>location.href=${JSON.stringify(link)}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
});
