/** The sentence inside a parsed error reply, wherever the sender put it. */
function messageIn(value: unknown, depth: number): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (depth <= 0 || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "error_description"]) {
    const found = messageIn(v[key], depth - 1);
    if (found) return found;
  }
  return null;
}

/** An error as it should be shown: the sentence to read, and the raw text when that says more. */
export interface ReadableError {
  text: string;
  /** The message exactly as it arrived, when `text` is only part of it. */
  details: string | null;
}

/**
 * Agents often pass on a service's raw reply, such as
 * `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
 * This pulls out the sentence a person can read and keeps the rest as details. Anything it
 * can't make sense of comes back as it was.
 */
export function readableError(raw: string, depth = 2): ReadableError {
  const asIs = { text: raw, details: null };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return asIs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return asIs;
  }
  let inner = messageIn(parsed, 3);
  if (!inner) return asIs;
  // Some services wrap one reply inside another's message.
  if (depth > 1 && inner.includes("{")) inner = readableError(inner, depth - 1).text;
  const lead = raw
    .slice(0, start)
    .trim()
    .replace(/[\s:,-]+$/, "");
  const text = lead ? `${inner} (${lead})` : inner;
  return text === raw.trim() ? asIs : { text, details: raw };
}
