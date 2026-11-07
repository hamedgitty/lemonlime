import { and, asc, eq } from "drizzle-orm";
import { secrets } from "@lemonlime/db";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";

/** Environment variable names a secret may use. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Names the sandbox and runner need for themselves. */
const RESERVED = new Set(["PATH", "HOME", "USER", "SHELL", "PWD", "LANG", "TERM", "HOSTNAME", "NODE_OPTIONS"]);
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_SECRETS_PER_WORKSPACE = 100;

export interface SecretSummary {
  name: string;
  updatedAt: string;
}

export function validateSecretName(name: string): string | null {
  if (!SECRET_NAME.test(name)) return "Use capital letters, digits and underscores, starting with a letter or underscore (like NPM_TOKEN).";
  if (name.startsWith("LEMONLIME_")) return "Names starting with LEMONLIME_ are used by LemonLime itself.";
  if (RESERVED.has(name)) return `${name} is set by the sandbox itself and can't be a secret.`;
  return null;
}

const keys = new WeakMap<AppContext, Promise<CryptoKey>>();

/**
 * The encryption key: LEMONLIME_SECRETS_KEY if set (32 random bytes, base64), otherwise
 * derived from LEMONLIME_TOKEN_SECRET with HKDF, so no extra setting is needed. Changing
 * either makes stored secrets unreadable (they have to be entered again).
 */
function secretsKey(ctx: AppContext): Promise<CryptoKey> {
  let key = keys.get(ctx);
  if (!key) {
    key = (async () => {
      const explicit = ctx.vars.LEMONLIME_SECRETS_KEY;
      if (explicit) {
        const raw = Uint8Array.from(atob(explicit), c => c.charCodeAt(0));
        if (raw.length !== 32) throw new Error("LEMONLIME_SECRETS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).");
        return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      }
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(ctx.config.tokenSecret()), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("lemonlime"), info: new TextEncoder().encode("lemonlime/secrets/v1") },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keys.set(ctx, key);
  }
  return key;
}

/** The workspace and name are bound to the ciphertext, so a value can't be moved to another row. */
const aad = (workspaceId: string, name: string) => new TextEncoder().encode(`${workspaceId}\n${name}`);

export async function encryptSecret(ctx: AppContext, workspaceId: string, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(workspaceId, name) }, await secretsKey(ctx), new TextEncoder().encode(value)),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return `v1:${btoa(String.fromCharCode(...out))}`;
}

export async function decryptSecret(ctx: AppContext, workspaceId: string, name: string, stored: string): Promise<string> {
  if (!stored.startsWith("v1:")) throw new Error("unknown secret format");
  const bytes = Uint8Array.from(atob(stored.slice(3)), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(workspaceId, name) },
    await secretsKey(ctx),
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}

/** Names only, never values. */
export async function listSecrets(ctx: AppContext, workspaceId: string): Promise<SecretSummary[]> {
  const rows = await ctx.db
    .select({ name: secrets.name, updatedAt: secrets.updatedAt })
    .from(secrets)
    .where(eq(secrets.workspaceId, workspaceId))
    .orderBy(asc(secrets.name));
  return rows;
}

export async function setSecret(ctx: AppContext, userId: string, workspaceId: string, name: string, value: string): Promise<SecretSummary> {
  const problem = validateSecretName(name);
  if (problem) throw new HttpError(400, problem);
  if (!value) throw new HttpError(400, "Enter a value.");
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) throw new HttpError(400, "Secrets can be at most 32 KB.");
  const existing = await listSecrets(ctx, workspaceId);
  if (!existing.some(s => s.name === name) && existing.length >= MAX_SECRETS_PER_WORKSPACE)
    throw new HttpError(400, `A workspace can have at most ${MAX_SECRETS_PER_WORKSPACE} secrets.`);
  const ciphertext = await encryptSecret(ctx, workspaceId, name, value);
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .insert(secrets)
    .values({ workspaceId, name, ciphertext, createdBy: userId })
    .onConflictDoUpdate({ target: [secrets.workspaceId, secrets.name], set: { ciphertext, updatedAt: now } })
    .returning({ name: secrets.name, updatedAt: secrets.updatedAt });
  return row!;
}

export async function deleteSecret(ctx: AppContext, workspaceId: string, name: string): Promise<boolean> {
  const rows = await ctx.db
    .delete(secrets)
    .where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name)))
    .returning({ name: secrets.name });
  return rows.length > 0;
}

/**
 * Every secret of a workspace, decrypted, for a new sandbox's environment. A secret that
 * can't be decrypted (the key changed) is left out rather than failing the sandbox.
 */
export async function secretsForSandbox(ctx: AppContext, workspaceId: string): Promise<Record<string, string>> {
  const rows = await ctx.db.select().from(secrets).where(eq(secrets.workspaceId, workspaceId));
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.name] = await decryptSecret(ctx, workspaceId, r.name, r.ciphertext);
    } catch {
      console.warn(`[lemonlime] secret ${r.name} could not be decrypted (was the key changed?); not passed to the sandbox`);
    }
  }
  return out;
}
