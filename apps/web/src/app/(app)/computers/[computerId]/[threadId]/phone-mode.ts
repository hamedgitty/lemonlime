/**
 * How this browser may reach a thread on one of the user's computers:
 * - `sealed`: it holds the computer's pairing key, so it only ever talks to it sealed;
 * - `pair-first`: the computer only answers paired phones and this browser isn't one;
 * - `unsealed`: an older desktop app that doesn't pair, reached the way it always was.
 */
export type PhoneMode = "sealed" | "pair-first" | "unsealed";

/**
 * A browser that holds a key insists on sealing whatever the server says about the
 * computer, so a server can't talk it into an open connection.
 */
export function phoneMode(hasKey: boolean, computerSeals: boolean): PhoneMode {
  if (hasKey) return "sealed";
  return computerSeals ? "pair-first" : "unsealed";
}
