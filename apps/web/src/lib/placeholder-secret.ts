/** What .env.example puts where a secret goes. Anyone can read it there, so a secret left as this protects nothing. */
export const PLACEHOLDER_SECRET = "replace-with-a-long-random-string";

/** True for a secret that is still what .env.example shipped. */
export function leftAsPlaceholder(value: string | undefined): boolean {
  return value === PLACEHOLDER_SECRET;
}

/** What to say when a secret was never filled in. */
export function placeholderError(name: string): Error {
  return new Error(`${name} is still the placeholder from .env.example. Set a real one: see docs/self-hosting.md.`);
}
