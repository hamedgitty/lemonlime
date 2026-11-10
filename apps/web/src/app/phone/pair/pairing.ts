import { parsePairingLink } from "@lemonlime/protocol";
import { savePairing, type PairingStorage } from "@lemonlime/client";

/** What became of the pairing link this page was opened with. */
export type PairingOutcome =
  | { state: "paired"; computerId: string }
  /** The browser wouldn't keep the key (private browsing, or storage switched off). */
  | { state: "not-kept" }
  /** The link is incomplete or was changed. */
  | { state: "malformed" }
  /** The page was opened without a pairing link. */
  | { state: "none" };

/**
 * Take the pairing key out of the address's fragment and keep it in this browser. The
 * fragment is only read here: it is never put in a request, a link or a message.
 */
export function acceptPairing(fragment: string, storage?: PairingStorage | null): PairingOutcome {
  const text = fragment.replace(/^#/, "");
  if (!text) return { state: "none" };
  const pairing = parsePairingLink(text);
  if (!pairing) return { state: "malformed" };
  const kept = storage === undefined ? savePairing(pairing) : savePairing(pairing, storage);
  return kept ? { state: "paired", computerId: pairing.computerId } : { state: "not-kept" };
}
