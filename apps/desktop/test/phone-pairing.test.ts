import { beforeEach, describe, expect, it } from "vitest";
import { normalizePairingKey } from "@lemonlime/protocol";
import { forgetUnkeptPairingKey, loadPairingKey, replacePairingKey, type PairingKeyStore } from "../src/lib/phonePairing.ts";

/** A keychain that holds one value. */
function keychain(initial: string | null = null): PairingKeyStore & { value: string | null } {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async set(value: string) {
      this.value = value;
    },
  };
}

/** A keychain that won't hold this value. */
const refusing: PairingKeyStore = {
  get: async () => {
    throw new Error("not allowed");
  },
  set: async () => {
    throw new Error("not allowed");
  },
};

describe("this computer's pairing key", () => {
  beforeEach(() => forgetUnkeptPairingKey());

  it("is made the first time it is asked for, and kept in the keychain", async () => {
    const store = keychain();
    const first = await loadPairingKey(store);
    expect(first.kept).toBe(true);
    expect(normalizePairingKey(first.key)).toBe(first.key);
    expect(store.value).toBe(first.key);
  });

  it("stays the same from then on", async () => {
    const store = keychain();
    const first = await loadPairingKey(store);
    expect(await loadPairingKey(store)).toEqual(first);
  });

  it("is replaced by a new one when every phone is unpaired", async () => {
    const store = keychain();
    const first = await loadPairingKey(store);
    const second = await replacePairingKey(store);
    expect(second.key).not.toBe(first.key);
    expect(second.kept).toBe(true);
    expect(await loadPairingKey(store)).toEqual(second);
  });

  it("is made again when what the keychain holds isn't a pairing key", async () => {
    const store = keychain("not a key");
    const made = await loadPairingKey(store);
    expect(made.kept).toBe(true);
    expect(store.value).toBe(made.key);
  });

  it("lasts while the app runs when the keychain won't hold it, and says it wasn't kept", async () => {
    const first = await loadPairingKey(refusing);
    expect(first.kept).toBe(false);
    expect(await loadPairingKey(refusing)).toEqual(first);
    const second = await replacePairingKey(refusing);
    expect(second.kept).toBe(false);
    expect(second.key).not.toBe(first.key);
    expect(await loadPairingKey(refusing)).toEqual(second);
  });

  it("is held in memory only when there is no keychain at all", async () => {
    const first = await loadPairingKey(null);
    expect(first.kept).toBe(false);
    expect(await loadPairingKey(null)).toEqual(first);
  });
});
