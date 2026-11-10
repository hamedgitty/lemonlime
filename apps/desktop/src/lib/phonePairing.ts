import { invoke, isTauri } from "@tauri-apps/api/core";
import { newPairingKey, normalizePairingKey } from "@lemonlime/protocol";

/**
 * This computer's pairing key for phone access (docs/phone-access.md): the secret a paired
 * phone shares with this computer, which the control plane never sees. It lives with the
 * app's other secrets in the operating system's keychain, never in settings or local storage.
 */

const SECRET_NAME = "phone-pairing-key";

/** Where the key is kept. */
export interface PairingKeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

export interface PairingKey {
  key: string;
  /**
   * False when the keychain wouldn't take the key. It then lasts until the app quits, and
   * phones have to be paired again after that.
   */
  kept: boolean;
}

const keychain: PairingKeyStore = {
  get: () => invoke<string | null>("secret_get", { name: SECRET_NAME }),
  set: value => invoke("secret_set", { name: SECRET_NAME, value }),
};

/** The key in use when the keychain can't hold one, so it stays the same while the app runs. */
let unkept: string | null = null;

function defaultStore(): PairingKeyStore | null {
  return isTauri() ? keychain : null;
}

async function keep(key: string, store: PairingKeyStore | null): Promise<PairingKey> {
  try {
    if (!store) throw new Error("no keychain");
    await store.set(key);
    unkept = null;
    return { key, kept: true };
  } catch {
    unkept = key;
    return { key, kept: false };
  }
}

/** This computer's pairing key, made the first time it is asked for. */
export async function loadPairingKey(store: PairingKeyStore | null = defaultStore()): Promise<PairingKey> {
  try {
    const kept = normalizePairingKey((await store?.get()) ?? "");
    if (kept) return { key: kept, kept: true };
  } catch {
    /* treated as nothing kept */
  }
  if (unkept) return { key: unkept, kept: false };
  return keep(newPairingKey(), store);
}

/** Replace the key with a new one: every phone paired with the old one stops working. */
export function replacePairingKey(store: PairingKeyStore | null = defaultStore()): Promise<PairingKey> {
  return keep(newPairingKey(), store);
}

/** For tests: forget the key held outside the keychain. */
export function forgetUnkeptPairingKey(): void {
  unkept = null;
}
