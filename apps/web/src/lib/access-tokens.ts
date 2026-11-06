import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Personal access tokens look like `llpat_<43 base64url chars>`. */
export const ACCESS_TOKEN_PREFIX = "llpat_";
const ACCESS_TOKEN_RE = /^llpat_[A-Za-z0-9_-]{43}$/;

export function generateAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function looksLikeAccessToken(value: string): boolean {
  return ACCESS_TOKEN_RE.test(value);
}

/** Only this hash is stored; the raw token is shown to the user once. */
export function hashAccessToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
