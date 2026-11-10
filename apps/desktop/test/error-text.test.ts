import { describe, expect, it } from "vitest";
import { readableError } from "../src/lib/errorText.ts";

describe("readableError", () => {
  it("leaves a plain sentence alone", () => {
    expect(readableError("The agent stopped answering.")).toEqual({ text: "The agent stopped answering.", details: null });
  });

  it("pulls the sentence out of a service's reply and keeps the reply as details", () => {
    const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(readableError(raw)).toEqual({ text: "Overloaded (API Error: 529)", details: raw });
  });

  it("reads a reply with nothing in front of it", () => {
    const raw = '{"error":"Your sign-in has expired."}';
    expect(readableError(raw)).toEqual({ text: "Your sign-in has expired.", details: raw });
  });

  it("reads a message at the top of the reply", () => {
    const raw = 'Request failed: {"message":"Not found","status":404}';
    expect(readableError(raw)).toEqual({ text: "Not found (Request failed)", details: raw });
  });

  it("reads a reply wrapped inside another reply's message", () => {
    const inner = JSON.stringify({ error: { message: "Quota used up" } });
    const raw = `Error 429: ${JSON.stringify({ error: { message: inner } })}`;
    expect(readableError(raw)).toEqual({ text: "Quota used up (Error 429)", details: raw });
  });

  it("gives back text it can't parse", () => {
    for (const raw of ["Unexpected token } in {broken", "{not json}", "ended with }", "{}", '{"code":7}', "{", ""]) {
      expect(readableError(raw)).toEqual({ text: raw, details: null });
    }
  });

  it("doesn't dig forever into a deep reply", () => {
    const raw = JSON.stringify({ error: { error: { error: { error: { message: "too deep" } } } } });
    expect(readableError(raw)).toEqual({ text: raw, details: null });
  });
});
