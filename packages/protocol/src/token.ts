import { z } from "zod";
import { ThreadId } from "./thread.ts";

/**
 * Runner tokens: compact HMAC-SHA256 signed claims (`<payload>.<signature>`,
 * both base64url). Uses Web Crypto so it works in Node, browsers and edge runtimes.
 *
 * - `client` tokens let an app open the thread's WebSocket.
 * - `runner` tokens let a runner post heartbeats for its own thread.
 * - `relay` tokens let the control plane collect and answer a runner's relayed calls,
 *   when the runner can't reach the control plane itself (see RelayedRequest).
 */
export const TokenScope = z.enum(["client", "runner", "relay"]);
export type TokenScope = z.infer<typeof TokenScope>;

export const TokenClaims = z.object({
  threadId: ThreadId,
  scope: TokenScope,
  /** Unix seconds. */
  exp: z.number().int().positive(),
  /** Subject (user id) for client tokens. */
  sub: z.string().optional(),
});
export type TokenClaims = z.infer<typeof TokenClaims>;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 16) throw new Error("token secret must be at least 16 characters");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * Each thread gets its own secret, derived from the deployment's master secret.
 * The runner only ever sees its thread's secret, so a compromised sandbox cannot
 * sign tokens for any other thread.
 */
export async function deriveThreadSecret(masterSecret: string, threadId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(masterSecret), enc.encode(`lemonlime-thread:${threadId}`));
  return b64url(new Uint8Array(mac));
}

/**
 * The key the agent's own tools sign their requests with (previews, subagents, computer
 * access, git credentials). It is derived from the thread secret and can't be turned back
 * into it, so the agent never holds the secret: tokens signed with this key are accepted
 * only for those tools, never as the user (client) or as the runner talking to the
 * control plane.
 */
export async function deriveAgentKey(threadSecret: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(threadSecret), enc.encode("lemonlime-agent-tools"));
  return b64url(new Uint8Array(mac));
}

/** Longest lifetime a runner or client should accept on a token, from now. */
export const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(TokenClaims.parse(claims))));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export type VerifyResult = { ok: true; claims: TokenClaims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts as [string, string];
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromB64url(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, enc.encode(payload));
  if (!valid) return { ok: false, reason: "bad_signature" };
  let claims: TokenClaims;
  try {
    const parsed = TokenClaims.safeParse(JSON.parse(dec.decode(fromB64url(payload))));
    if (!parsed.success) return { ok: false, reason: "malformed" };
    claims = parsed.data;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
