import { describe, expect, it } from "vitest";
import { reuseRows, sameValue } from "../src/lib/stable.ts";

describe("sameValue", () => {
  it("compares plain values, arrays, maps and objects by what they hold", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue("a", "b")).toBe(false);
    expect(sameValue({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue(new Map([["k", { n: 1 }]]), new Map([["k", { n: 1 }]]))).toBe(true);
    expect(sameValue(new Map([["k", 1]]), new Map([["j", 1]]))).toBe(false);
  });

  it("tells an array from an object with the same entries", () => {
    expect(sameValue([], {})).toBe(false);
    expect(sameValue({ 0: "a" }, ["a"])).toBe(false);
  });

  it("only says yes past its depth for the very same object", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(sameValue(deep, { a: { b: { c: { d: 1 } } } })).toBe(false);
    expect(sameValue(deep, { a: { b: { c: deep.a.b.c } } })).toBe(true);
    expect(sameValue(deep, { a: { b: { c: { d: 1 } } } }, 5)).toBe(true);
  });

  it("never calls two different class instances the same", () => {
    expect(sameValue(new Date(0), new Date(0))).toBe(false);
    expect(sameValue(/a/, /a/)).toBe(false);
  });
});

describe("reuseRows", () => {
  const row = (key: string, text: string) => ({ key, text, result: { output: text } });

  it("gives back the earlier list when a rebuild changed nothing", () => {
    const prev = [row("a", "one"), row("b", "two")];
    expect(reuseRows(prev, [row("a", "one"), row("b", "two")])).toBe(prev);
  });

  it("keeps the earlier objects for rows that say the same, and takes the new ones where they differ", () => {
    const prev = [row("a", "one"), row("b", "two")];
    const next = [row("a", "one"), row("b", "two!"), row("c", "three")];
    const out = reuseRows(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[2]).toBe(next[2]);
  });

  it("notices rows that moved or went away", () => {
    const prev = [row("a", "one"), row("b", "two")];
    const swapped = reuseRows(prev, [row("b", "two"), row("a", "one")]);
    expect(swapped).not.toBe(prev);
    expect(swapped).toEqual([prev[1], prev[0]]);
    expect(swapped[0]).toBe(prev[1]);
    const shorter = reuseRows(prev, [row("a", "one")]);
    expect(shorter).not.toBe(prev);
    expect(shorter).toEqual([prev[0]]);
  });

  it("handles an empty list either way", () => {
    const none: { key: string }[] = [];
    expect(reuseRows(none, [])).toBe(none);
    expect(reuseRows([row("a", "one")], [])).toEqual([]);
  });
});
