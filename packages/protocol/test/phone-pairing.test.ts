import { describe, expect, it } from "vitest";
import {
  BRIDGE_CLOSE,
  ComputerUpdate,
  LINK_FRAME_MAX_BYTES,
  NOT_PAIRED_REASON,
  PHONE_FRAME_MAX_BYTES,
  SEAL_CHUNK_BYTES,
  SealError,
  SealedChannel,
  frameBytes,
  isNotPairedClose,
  newPairingKey,
  newSealHello,
  normalizePairingKey,
  pairingLink,
  parsePairingLink,
  parseSealHello,
  parseSealedFrame,
  type SealSession,
} from "../src/index.ts";

const COMPUTER = "computer-0123456789abcdef";
const THREAD = "thread-aaaaaa";

/** Both ends of one session. `computer` overrides what the computer's end believes. */
async function session(computer: Partial<SealSession> = {}) {
  const shared = { key: newPairingKey(), computerId: COMPUTER, threadId: THREAD, phoneNonce: newSealHello().nonce, computerNonce: newSealHello().nonce };
  return {
    shared,
    phone: await SealedChannel.start({ ...shared, side: "phone" }),
    computer: await SealedChannel.start({ ...shared, ...computer, side: "computer" }),
  };
}

/** One frame for a short message. */
async function frame(channel: SealedChannel, message: string): Promise<string> {
  const frames = await channel.seal(message);
  expect(frames).toHaveLength(1);
  return frames[0]!;
}

describe("a pairing link", () => {
  it("carries the computer and its key after the #, where no server sees them", () => {
    const key = newPairingKey();
    const link = pairingLink("https://lemonlime.example", { computerId: COMPUTER, key });
    expect(link).toBe(`https://lemonlime.example/phone/pair#v1.${COMPUTER}.${key}`);
    const url = new URL(link);
    expect(url.pathname).toBe("/phone/pair");
    expect(url.search).toBe("");
    expect(parsePairingLink(link)).toEqual({ computerId: COMPUTER, key });
  });

  it("is the same whether or not the control plane's address ends with a slash", () => {
    const pairing = { computerId: COMPUTER, key: newPairingKey() };
    expect(pairingLink("https://lemonlime.example/", pairing)).toBe(pairingLink("https://lemonlime.example", pairing));
  });

  it("is understood from the fragment alone, with or without its #", () => {
    const key = newPairingKey();
    expect(parsePairingLink(`#v1.${COMPUTER}.${key}`)).toEqual({ computerId: COMPUTER, key });
    expect(parsePairingLink(`v1.${COMPUTER}.${key}`)).toEqual({ computerId: COMPUTER, key });
  });

  it("is refused when it is incomplete or malformed", () => {
    const key = newPairingKey();
    const bad = [
      "",
      "#",
      "https://lemonlime.example/phone/pair",
      `#v2.${COMPUTER}.${key}`,
      `#${COMPUTER}.${key}`,
      `#v1.${COMPUTER}`,
      `#v1.${COMPUTER}.${key}.extra`,
      `#v1.Not A Computer.${key}`,
      `#v1.short.${key}`,
      `#v1.${COMPUTER}.${key.slice(0, 20)}`,
      `#v1.${COMPUTER}.${key}AAAA`,
      `#v1.${COMPUTER}.${"*".repeat(43)}`,
      `#v1.${COMPUTER}.`,
    ];
    for (const link of bad) expect(parsePairingLink(link), link).toBeNull();
  });
});

describe("a pairing key", () => {
  it("is 32 random bytes, different every time", () => {
    const a = newPairingKey();
    const b = newPairingKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(normalizePairingKey(a)).toBe(a);
  });

  it("is not just any text", () => {
    expect(normalizePairingKey("")).toBeNull();
    expect(normalizePairingKey("hello")).toBeNull();
    expect(normalizePairingKey(newPairingKey() + "AAAA")).toBeNull();
  });
});

describe("the hello that starts a sealed session", () => {
  it("carries a fresh nonce each time", () => {
    const a = newSealHello();
    const b = newSealHello();
    expect(a).toMatchObject({ type: "e2e_hello", v: 1 });
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(parseSealHello(JSON.stringify(a))).toEqual(a);
  });

  it("is not understood in another version, without a nonce, or when it is another frame", () => {
    const hello = newSealHello();
    expect(parseSealHello(JSON.stringify({ ...hello, v: 2 }))).toBeNull();
    expect(parseSealHello(JSON.stringify({ type: "e2e_hello", v: 1 }))).toBeNull();
    expect(parseSealHello(JSON.stringify({ ...hello, nonce: "short" }))).toBeNull();
    expect(parseSealHello(JSON.stringify({ type: "hello", resumeFrom: 0 }))).toBeNull();
    expect(parseSealHello("not json")).toBeNull();
  });
});

describe("a sealed session", () => {
  it("carries messages both ways, and what travels can't be read", async () => {
    const { phone, computer } = await session();
    const sent = await frame(phone, JSON.stringify({ type: "send_message", text: "fix the login page" }));
    expect(sent).not.toContain("login");
    expect(parseSealedFrame(sent)).toMatchObject({ type: "e2e", n: 0 });
    expect(await computer.open(sent)).toBe(JSON.stringify({ type: "send_message", text: "fix the login page" }));

    const back = await frame(computer, "done, and ünïcödé survives ✓");
    expect(back).not.toContain("done");
    expect(await phone.open(back)).toBe("done, and ünïcödé survives ✓");
  });

  it("numbers each direction's frames from 0", async () => {
    const { phone, computer } = await session();
    for (const n of [0, 1, 2]) {
      const up = await frame(phone, `up ${n}`);
      expect(parseSealedFrame(up)?.n).toBe(n);
      expect(await computer.open(up)).toBe(`up ${n}`);
    }
    expect(parseSealedFrame(await frame(computer, "down"))?.n).toBe(0);
  });

  it("keeps messages sealed at the same moment in the order they were given", async () => {
    const { phone, computer } = await session();
    const sealed = await Promise.all(["one", "two", "three"].map(m => phone.seal(m)));
    const opened = await Promise.all(sealed.flat().map(f => computer.open(f)));
    expect(opened).toEqual(["one", "two", "three"]);
  });

  it("doesn't open for someone with another key", async () => {
    const { phone } = await session();
    const { computer: stranger } = await session();
    await expect(stranger.open(await frame(phone, "hello"))).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open the same frame twice", async () => {
    const { phone, computer } = await session();
    const once = await frame(phone, "delete the branch");
    expect(await computer.open(once)).toBe("delete the branch");
    await expect(computer.open(once)).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open frames out of order, or after one went missing", async () => {
    const { phone, computer } = await session();
    await frame(phone, "first");
    const second = await frame(phone, "second");
    await expect(computer.open(second)).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open a frame that was renumbered to look like the next one", async () => {
    const { phone, computer } = await session();
    await frame(phone, "first");
    const second = parseSealedFrame(await frame(phone, "second"))!;
    await expect(computer.open(JSON.stringify({ ...second, n: 0 }))).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open a frame that was changed on the way", async () => {
    const { phone, computer } = await session();
    const sealed = parseSealedFrame(await frame(phone, "approve nothing"))!;
    const flipped = sealed.c.slice(0, 5) + (sealed.c[5] === "A" ? "B" : "A") + sealed.c.slice(6);
    await expect(computer.open(JSON.stringify({ ...sealed, c: flipped }))).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open anything that isn't a sealed frame", async () => {
    for (const raw of ['{"type":"send_message","text":"hi"}', '{"type":"e2e","n":0}', '{"type":"e2e","n":0,"c":"***"}', "not json"]) {
      const { computer } = await session();
      await expect(computer.open(raw), raw).rejects.toBeInstanceOf(SealError);
    }
  });

  it("is over after one bad frame: even the right next frame no longer opens", async () => {
    const { phone, computer } = await session();
    const good = await frame(phone, "hello");
    await expect(computer.open("not json")).rejects.toBeInstanceOf(SealError);
    await expect(computer.open(good)).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open at the end that sealed it", async () => {
    const { phone, computer } = await session();
    await expect(phone.open(await frame(phone, "echo"))).rejects.toBeInstanceOf(SealError);
    await expect(computer.open(await frame(computer, "echo"))).rejects.toBeInstanceOf(SealError);
  });

  it("doesn't open in another session with the same key", async () => {
    for (const other of [{ phoneNonce: newSealHello().nonce }, { computerNonce: newSealHello().nonce }]) {
      const { phone, computer } = await session(other);
      await expect(computer.open(await frame(phone, "hello")), Object.keys(other).join()).rejects.toBeInstanceOf(SealError);
    }
  });

  it("doesn't open for another thread or another computer with the same key", async () => {
    for (const other of [{ threadId: "thread-bbbbbb" }, { computerId: "computer-fedcba9876543210" }]) {
      const { phone, computer } = await session(other);
      await expect(computer.open(await frame(phone, "hello")), JSON.stringify(other)).rejects.toBeInstanceOf(SealError);
    }
  });

  it("can't be started with something that isn't a pairing key or a nonce", async () => {
    const { shared } = await session();
    await expect(SealedChannel.start({ ...shared, key: "too-short", side: "phone" })).rejects.toBeInstanceOf(SealError);
    await expect(SealedChannel.start({ ...shared, phoneNonce: "x", side: "phone" })).rejects.toBeInstanceOf(SealError);
    await expect(SealedChannel.start({ ...shared, computerNonce: "", side: "computer" })).rejects.toBeInstanceOf(SealError);
  });
});

describe("a long message in a sealed session", () => {
  it("travels as several frames that each fit a phone's frame limit, and arrives whole", async () => {
    const { phone, computer } = await session();
    const long = "é".repeat(PHONE_FRAME_MAX_BYTES / 2);
    const frames = await phone.seal(long);
    expect(frames.length).toBe(Math.ceil(PHONE_FRAME_MAX_BYTES / SEAL_CHUNK_BYTES));
    for (const f of frames) expect(frameBytes(f)).toBeLessThanOrEqual(PHONE_FRAME_MAX_BYTES);
    const opened = [];
    for (const f of frames) opened.push(await computer.open(f));
    expect(opened.slice(0, -1).every(part => part === null)).toBe(true);
    expect(opened.at(-1)).toBe(long);
    // The next message starts clean.
    expect(await computer.open(await frame(phone, "and a short one"))).toBe("and a short one");
  });

  it("carries a message the size of the biggest a runner may send a phone", async () => {
    const { phone, computer } = await session();
    const big = "x".repeat(LINK_FRAME_MAX_BYTES);
    const frames = await computer.seal(big);
    let whole: string | null = null;
    for (const f of frames) whole = await phone.open(f);
    expect(whole === big).toBe(true);
  });

  it("can't be cut short by dropping its last part", async () => {
    const { phone, computer } = await session();
    const frames = await phone.seal("a".repeat(SEAL_CHUNK_BYTES + 10));
    expect(frames).toHaveLength(2);
    expect(await computer.open(frames[0]!)).toBeNull();
    // The next message's frame carries a number the computer isn't waiting for.
    await expect(computer.open(await frame(phone, "the next message"))).rejects.toBeInstanceOf(SealError);
  });

  it("is refused when it is bigger than the other end takes", async () => {
    const { phone, computer } = await session();
    await expect(phone.seal("a".repeat(PHONE_FRAME_MAX_BYTES + 1))).rejects.toBeInstanceOf(SealError);
    await expect(computer.seal("a".repeat(LINK_FRAME_MAX_BYTES + 1))).rejects.toBeInstanceOf(SealError);
    // Refusing a message uses no frame numbers: the session carries on.
    expect(await computer.open(await frame(phone, "still here"))).toBe("still here");
  });
});

describe("what a computer says about itself", () => {
  const update = { name: "Studio Mac", platform: "mac", phoneAccess: true };

  it("may say that it seals phone sessions", () => {
    expect(ComputerUpdate.parse({ ...update, sealed: true }).sealed).toBe(true);
  });

  it("is still understood from an app that doesn't say", () => {
    expect(ComputerUpdate.parse(update).sealed).toBeUndefined();
  });
});

describe("a connection closed for want of pairing", () => {
  it("is recognised by its code, or by its reason when the code was lost on the way", () => {
    expect(isNotPairedClose(BRIDGE_CLOSE.notPaired, "")).toBe(true);
    expect(isNotPairedClose(1000, NOT_PAIRED_REASON)).toBe(true);
    expect(isNotPairedClose(1000, "")).toBe(false);
    expect(isNotPairedClose(BRIDGE_CLOSE.offline, "your computer is offline")).toBe(false);
    expect(isNotPairedClose(undefined, undefined)).toBe(false);
  });
});
