import { useSyncExternalStore } from "react";

const never = () => () => {};

/**
 * False on the server and while the browser takes over the page the server sent, true
 * from then on. What only the browser knows (its time zone, its clock, how it writes
 * dates) waits for this, so the first thing the browser draws is what the server drew.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
}

/**
 * The language dates are written in: one fixed choice until the browser has taken over,
 * since the server can't know the reader's, then the reader's own.
 */
export const dateLocale = (hydrated: boolean): string | undefined => (hydrated ? undefined : "en-US");
