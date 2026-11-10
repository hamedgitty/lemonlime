import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalThreadSnapshot } from "@lemonlime/protocol";
import type { CloudApi } from "./cloud.ts";
import { PhoneLink, computerId, computerPlatform, defaultComputerName, type PhoneLinkState } from "./phoneBridge.ts";
import { loadPairingKey, replacePairingKey } from "./phonePairing.ts";

const KEY_REGISTERED = "lemonlime:phone-registered";

function flag(on: boolean | null): boolean {
  try {
    if (on === true) localStorage.setItem(KEY_REGISTERED, "1");
    else if (on === false) localStorage.removeItem(KEY_REGISTERED);
    return localStorage.getItem(KEY_REGISTERED) === "1";
  } catch {
    return false;
  }
}

/** What a phone needs to pair with this computer. It is a secret: show it only when asked. */
export interface PhonePairing {
  computerId: string;
  key: string;
  /** False when the key couldn't be saved on this computer, so it only lasts until the app quits. */
  kept: boolean;
}

export interface PhoneAccess {
  state: PhoneLinkState;
  detail: string | null;
  /** Cut every phone session now and tell the control plane phone access is off. */
  turnOff: () => Promise<void>;
  /** Null while phone access is off, and for a moment after it is turned on. */
  pairing: PhonePairing | null;
  /** Make a new pairing key. Every paired phone is cut off and has to be paired again. */
  unpairAll: () => Promise<void>;
}

/** Keeps this computer's phone link open while phone access is on (see phoneBridge.ts). */
export function usePhoneLink(opts: {
  enabled: boolean;
  api: CloudApi | null;
  name: string;
  snapshots: LocalThreadSnapshot[];
  runner: (threadId: string) => Promise<{ port: number; secret: string } | null>;
}): PhoneAccess {
  const { enabled, api, name } = opts;
  const [state, setState] = useState<PhoneLinkState>("off");
  const [detail, setDetail] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const keyRef = useRef<string | null>(null);
  const linkRef = useRef<PhoneLink | null>(null);
  const snapshotsRef = useRef(opts.snapshots);
  snapshotsRef.current = opts.snapshots;
  const runnerRef = useRef(opts.runner);
  runnerRef.current = opts.runner;

  useEffect(() => {
    if (!api) return;
    if (!enabled) {
      // Turned off while the control plane couldn't be told (or before a restart): tell it now.
      if (flag(null)) {
        const platform = computerPlatform();
        void api
          .saveComputer(computerId(), { name: name || defaultComputerName(platform), platform, phoneAccess: false })
          .then(() => flag(false))
          .catch(() => undefined);
      }
      return;
    }
    const platform = computerPlatform();
    const id = computerId();
    const link = new PhoneLink({
      api,
      computer: { id, name: name || defaultComputerName(platform), platform },
      threads: () => snapshotsRef.current,
      runner: threadId => runnerRef.current(threadId),
      pairingKey: () => keyRef.current,
      onState: (s, d) => {
        setState(s);
        setDetail(d ?? null);
      },
    });
    let live = true;
    // The link opens once the pairing key is at hand, so no phone is turned away for want of it.
    void loadPairingKey().then(({ key, kept }) => {
      if (!live) return;
      keyRef.current = key;
      setPairing({ computerId: id, key, kept });
      linkRef.current = link;
      flag(true);
      link.start();
    });
    return () => {
      live = false;
      linkRef.current = null;
      void link.stop({ tell: false });
    };
  }, [enabled, api, name]);

  // Tell the dashboard when threads change (debounced in the link).
  useEffect(() => {
    linkRef.current?.threadsChanged();
  }, [opts.snapshots]);

  const turnOff = useCallback(async () => {
    const link = linkRef.current;
    linkRef.current = null;
    if (!link) return;
    try {
      await link.stop();
      flag(false);
    } catch {
      /* the flag stays, and the next start of the app tells the control plane */
    }
  }, []);

  const unpairAll = useCallback(async () => {
    const { key, kept } = await replacePairingKey();
    keyRef.current = key;
    setPairing({ computerId: computerId(), key, kept });
    linkRef.current?.unpairPhones();
  }, []);

  const on = enabled && api !== null;
  return { state: on ? state : "off", detail, turnOff, pairing: on ? pairing : null, unpairAll };
}
