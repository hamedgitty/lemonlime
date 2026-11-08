import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalThreadSnapshot } from "@lemonlime/protocol";
import type { CloudApi } from "./cloud.ts";
import { PhoneLink, computerId, computerPlatform, defaultComputerName, type PhoneLinkState } from "./phoneBridge.ts";

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

export interface PhoneAccess {
  state: PhoneLinkState;
  detail: string | null;
  /** Cut every phone session now and tell the control plane phone access is off. */
  turnOff: () => Promise<void>;
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
    const link = new PhoneLink({
      api,
      computer: { id: computerId(), name: name || defaultComputerName(platform), platform },
      threads: () => snapshotsRef.current,
      runner: id => runnerRef.current(id),
      onState: (s, d) => {
        setState(s);
        setDetail(d ?? null);
      },
    });
    linkRef.current = link;
    flag(true);
    link.start();
    return () => {
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

  return { state: enabled && api ? state : "off", detail, turnOff };
}
