import { describe, expect, it } from "vitest";
import { loadPairingKey, type PairingStorage } from "@lemonlime/client";
import { newPairingKey, pairingLink } from "@lemonlime/protocol";
import { acceptPairing } from "../src/app/phone/pair/pairing.ts";
import { phoneMode } from "../src/app/(app)/computers/[computerId]/[threadId]/phone-mode.ts";

/** Pairing a phone's browser with a computer, and what the dashboard does with the pairing. */

const COMPUTER = "computer-0123456789abcdef";

/** A browser's storage that keeps what it is given. */
function memory(): PairingStorage & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: key => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
    removeItem: key => void kept.delete(key),
  };
}

/** The part of a pairing link after the address, as the browser gives it to the page. */
function fragmentFor(key: string, computerId = COMPUTER): string {
  return new URL(pairingLink("https://lemonlime.example", { computerId, key })).hash;
}

describe("the page a pairing link opens", () => {
  it("keeps the computer's key in this browser, where the thread page finds it", () => {
    const storage = memory();
    const key = newPairingKey();
    expect(acceptPairing(fragmentFor(key), storage)).toEqual({ state: "paired", computerId: COMPUTER });
    expect(loadPairingKey(COMPUTER, storage)).toBe(key);
    // Only for that computer.
    expect(loadPairingKey("computer-ffffffffffffffff", storage)).toBeNull();
  });

  it("replaces the key when the computer is paired again", () => {
    const storage = memory();
    const [first, second] = [newPairingKey(), newPairingKey()];
    acceptPairing(fragmentFor(first), storage);
    expect(acceptPairing(fragmentFor(second), storage)).toEqual({ state: "paired", computerId: COMPUTER });
    expect(loadPairingKey(COMPUTER, storage)).toBe(second);
  });

  it.each([
    ["only part of the link arrived", "#v1.computer-0123456789abcdef"],
    ["the key was cut short", `#v1.${COMPUTER}.${newPairingKey().slice(0, 20)}`],
    ["it is another version", `#v2.${COMPUTER}.${newPairingKey()}`],
    ["the computer isn't one", `#v1.not a computer.${newPairingKey()}`],
    ["it is something else entirely", "#section-2"],
  ])("refuses the link and keeps nothing when %s", (_why, fragment) => {
    const storage = memory();
    expect(acceptPairing(fragment, storage)).toEqual({ state: "malformed" });
    expect(storage.kept.size).toBe(0);
  });

  it("asks for a code to be scanned when it was opened without one", () => {
    const storage = memory();
    expect(acceptPairing("", storage)).toEqual({ state: "none" });
    expect(acceptPairing("#", storage)).toEqual({ state: "none" });
    expect(storage.kept.size).toBe(0);
  });

  it("says so when the browser won't keep the key", () => {
    const fragment = fragmentFor(newPairingKey());
    // No storage at all.
    expect(acceptPairing(fragment, null)).toEqual({ state: "not-kept" });
    // Storage that refuses (as in some private windows).
    const refusing: PairingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage is full");
      },
      removeItem: () => {},
    };
    expect(acceptPairing(fragment, refusing)).toEqual({ state: "not-kept" });
    // Storage that takes the key and then doesn't have it.
    const forgetting: PairingStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(acceptPairing(fragment, forgetting)).toEqual({ state: "not-kept" });
  });
});

describe("how a browser reaches a thread on a computer", () => {
  it("seals when it holds the computer's key", () => {
    expect(phoneMode(true, true)).toBe("sealed");
  });

  it("still insists on sealing when the server says the computer doesn't seal", () => {
    expect(phoneMode(true, false)).toBe("sealed");
  });

  it("doesn't connect, and asks to be paired, when the computer seals and it has no key", () => {
    expect(phoneMode(false, true)).toBe("pair-first");
  });

  it("reaches an older desktop app the way it always did", () => {
    expect(phoneMode(false, false)).toBe("unsealed");
  });
});
