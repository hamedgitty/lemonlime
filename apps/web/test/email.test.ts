import { describe, expect, it, vi } from "vitest";
import { EmailNotConfiguredError, createEmailSender, emailBrand, inviteEmail, parseAddress, signInCodeEmail } from "../src/lib/email.ts";

const message = signInCodeEmail(emailBrand("https://app.example.com"), "ada@example.com", "123456", 10);

describe("parseAddress", () => {
  it("splits display names from addresses", () => {
    expect(parseAddress("LemonLime <sign-in@example.com>")).toEqual({ email: "sign-in@example.com", name: "LemonLime" });
    expect(parseAddress('"Lemon Lime" <a@b.c>')).toEqual({ email: "a@b.c", name: "Lemon Lime" });
    expect(parseAddress("a@b.c")).toEqual({ email: "a@b.c" });
  });
});

describe("createEmailSender", () => {
  const vars = { LEMONLIME_EMAIL_FROM: "LemonLime <sign-in@example.com>" };

  it("prefers the Cloudflare binding", async () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));
    const sender = createEmailSender({ vars: { ...vars, RESEND_API_KEY: "re_test" }, binding: { send }, production: true });
    expect(sender.name).toBe("cloudflare");
    await sender.send(message);
    expect(send).toHaveBeenCalledWith({
      to: "ada@example.com",
      from: { email: "sign-in@example.com", name: "LemonLime" },
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  });

  it("falls back to Resend", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const sender = createEmailSender({ vars: { ...vars, RESEND_API_KEY: "re_test" }, binding: null, production: true, fetch: fetchMock as typeof fetch });
    expect(sender.name).toBe("resend");
    await sender.send(message);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(init.body))).toMatchObject({ from: vars.LEMONLIME_EMAIL_FROM, to: ["ada@example.com"] });
  });

  it("reports a Resend failure", async () => {
    const fetchMock = vi.fn(async () => new Response("bad from", { status: 422 }));
    const sender = createEmailSender({ vars: { ...vars, RESEND_API_KEY: "re_test" }, binding: null, production: true, fetch: fetchMock as typeof fetch });
    await expect(sender.send(message)).rejects.toThrow(/422/);
  });

  it("needs a sender address", () => {
    expect(() => createEmailSender({ vars: { RESEND_API_KEY: "re_test" }, binding: null, production: true })).toThrow(/LEMONLIME_EMAIL_FROM/);
  });

  it("logs to the console in development and fails clearly in production", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const dev = createEmailSender({ vars: {}, binding: null, production: false });
    expect(dev.name).toBe("console");
    await dev.send(message);
    expect(info.mock.calls[0]?.[0]).toContain("123456");
    info.mockRestore();

    const prod = createEmailSender({ vars: {}, binding: null, production: true });
    expect(prod.name).toBe("none");
    await expect(prod.send(message)).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("writes the code into subject, text and HTML", () => {
    expect(message.subject).toContain("123456");
    expect(message.text).toContain("123456");
    expect(message.html).toContain("123456");
    expect(message.text).toContain("10 minutes");
  });
});

describe("inviteEmail", () => {
  const invite = (inviter: string, workspace = "Acme") =>
    inviteEmail(emailBrand("https://app.example.com"), { to: "bob@example.com", inviter, workspace, link: "https://app.example.com/invite/abc", days: 7 });

  it("names the inviter and the workspace", () => {
    const email = invite("Ada Lovelace");
    expect(email.subject).toBe("Ada Lovelace invited you to Acme on LemonLime");
    expect(email.html).toMatch(/<strong[^>]*>Ada Lovelace<\/strong> invited you to the <strong[^>]*>Acme<\/strong> workspace/);
    expect(email.text).toContain("Ada Lovelace invited you to the Acme workspace");
    expect(email.text).toContain("Accept the invitation: https://app.example.com/invite/abc");
  });

  it("shows a name as plain text, so it can't add a link, formatting or new lines", () => {
    const name = "Security team** [Confirm your account](https://bad.example/login) <img src=x>";
    const email = invite(name, "[Free credit](https://bad.example)");
    const links = [...email.html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    expect(links.filter(l => !l!.startsWith("https://app.example.com") && !l!.startsWith("https://lemonlime.dev") && !l!.startsWith("https://fonts."))).toEqual(
      [],
    );
    expect(email.html).not.toContain("<img src=x>");
    expect(email.html).toContain("Security team** [Confirm your account](https://bad.example/login) &lt;img src=x&gt;</strong>");
    expect(email.text).toContain(`${name} invited you to the [Free credit](https://bad.example) workspace`);
    expect(email.text).not.toContain("Confirm your account (https://bad.example/login)");

    const spread = invite("Ada\r\nBcc: everyone@example.com\n\nPay   now");
    expect(spread.subject).toBe("Ada Bcc: everyone@example.com Pay now invited you to Acme on LemonLime");
    expect(invite("x".repeat(500)).subject.length).toBeLessThan(140);
    expect(invite("  ").subject).toBe("Someone invited you to Acme on LemonLime");
  });
});
