import { z } from "zod";
import { createAccessTokenRow, listAccessTokens } from "@/lib/access.ts";
import { generateAccessToken, hashAccessToken } from "@/lib/access-tokens.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

const CreateAccessTokenRequest = z.object({ name: z.string().trim().min(1).max(100) });

/** Personal access tokens of the signed-in user (never their values). */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json({ tokens: await listAccessTokens(ctx.db, user.userId) });
});

/** Create a token. The raw value is in this response only; just its SHA-256 is stored. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  // A leaked token must not be able to mint more tokens.
  if (user.via !== "session") throw new HttpError(403, "Create tokens from the web dashboard.");
  const { name } = await parseBody(request, CreateAccessTokenRequest);
  const raw = generateAccessToken();
  const accessToken = await createAccessTokenRow(ctx.db, user.userId, name, hashAccessToken(raw));
  return json({ token: raw, accessToken }, 201);
});
