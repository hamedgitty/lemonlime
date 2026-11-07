import type { NewEvent } from "@lemonlime/protocol";

/** Values shorter than this aren't redacted: they would match ordinary text. */
const MIN_SECRET_LENGTH = 6;

/**
 * Replaces every occurrence of a secret's value, anywhere in an event (messages, tool
 * input and output, diffs), with `[secret NAME]`. Applied before an event is stored or
 * sent, so values never reach history, apps or the control plane.
 */
export function createRedactor(secrets: Record<string, string>): (event: NewEvent) => NewEvent {
  // Read on every event: secrets can be added later (e.g. after signing an agent in).
  let pairs: [string, string][] = [];
  let seen = -1;
  const refresh = () => {
    const keys = Object.keys(secrets).length;
    if (keys === seen) return;
    seen = keys;
    // Longest first, so a secret that contains another is replaced whole.
    pairs = Object.entries(secrets)
      .filter(([, v]) => v.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b[1].length - a[1].length);
  };
  const scrub = (s: string): string => {
    let out = s;
    for (const [name, value] of pairs) if (out.includes(value)) out = out.split(value).join(`[secret ${name}]`);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return event => {
    refresh();
    return pairs.length ? (walk(event) as NewEvent) : event;
  };
}

/** The secrets named in LEMONLIME_REDACT_ENV ("A,B"), with their values from the environment. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of (env.LEMONLIME_REDACT_ENV ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)) {
    const value = env[name];
    if (value) out[name] = value;
  }
  return out;
}
