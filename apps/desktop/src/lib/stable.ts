import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Whether two values hold the same things, looking up to `depth` levels into arrays, maps
 * and plain objects. Past that depth only the very same object counts, so a "yes" is always
 * right and a "no" may just mean it didn't look further.
 */
export function sameValue(a: unknown, b: unknown, depth = 3): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i], depth - 1)) return false;
    return true;
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameValue(v, b.get(k), depth - 1)) return false;
    return true;
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!(k in b) || !sameValue(a[k], b[k], depth - 1)) return false;
  return true;
}

/**
 * `next`, with every row that says the same as the row with its key in `prev` swapped for
 * that earlier object. A list rebuilt from scratch then only has new objects where
 * something changed, so rows drawn from the others can be skipped. When nothing changed at
 * all, `prev` itself comes back.
 */
export function reuseRows<T extends { key: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const before = new Map<string, T>();
  for (const row of prev) before.set(row.key, row);
  let same = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = before.get(row.key);
    const kept = old !== undefined && sameValue(old, row) ? old : row;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? (prev as T[]) : out;
}

/** A list of keyed rows that keeps its earlier objects wherever a rebuild changed nothing. */
export function useStableRows<T extends { key: string }>(rows: readonly T[]): T[] {
  const last = useRef<T[]>([]);
  return useMemo(() => (last.current = reuseRows(last.current, rows)), [rows]);
}

/** The earlier value for as long as a new one says the same thing. */
export function useStableValue<T>(value: T, depth = 3): T {
  const last = useRef(value);
  return useMemo(() => (sameValue(last.current, value, depth) ? last.current : (last.current = value)), [value, depth]);
}

/**
 * A function that never changes but always runs the newest `fn`, for handlers passed to
 * rows that should not draw again each time their parent does. Not for use while drawing.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- any handler's arguments
export function useStableCallback<F extends (...args: any[]) => unknown>(fn: F): F {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Parameters<F>) => latest.current(...args), []) as F;
}
