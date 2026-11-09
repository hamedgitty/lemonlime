import { describe, expect, it } from "vitest";
import { renderEmail, type EmailBrand } from "../src/index.ts";

const brand: EmailBrand = {
  name: "LemonLime",
  appUrl: "https://app.example.com",
  logoUrl: "https://app.example.com/email/lemonlime.png",
  supportEmail: "help@example.com",
  links: [{ label: "Dashboard", url: "https://app.example.com" }],
};

describe("renderEmail", () => {
  const email = renderEmail(
    {
      subject: "Your code",
      preview: "Use it soon.",
      title: "Your <sign-in> code",
      intro: ["Enter it in **LemonLime**. See [the docs](https://example.com/docs?a=1&b=2)."],
      code: "123456",
      details: [{ label: "Plan", value: "Team" }, { label: "Paid", value: "$12", strong: true }],
      button: { label: "Open LemonLime", url: "https://app.example.com/?x=1&y=2" },
      note: "If this wasn't you, ignore it.",
      reason: "You're getting this because you signed up.",
    },
    brand,
  );

  it("escapes text and allows bold and links", () => {
    expect(email.html).toContain("Your &lt;sign-in&gt; code");
    expect(email.html).toMatch(/<strong[^>]*>LemonLime<\/strong>/);
    expect(email.html).toContain('href="https://example.com/docs?a=1&amp;b=2"');
    expect(email.html).not.toContain("**");
  });

  it("has a hidden preview line, the logo, one button and the support address", () => {
    expect(email.html).toMatch(/<div style="display:none[^"]*">Use it soon\./);
    expect(email.html).toContain('src="https://app.example.com/email/lemonlime.png"');
    expect(email.html).toContain('href="https://app.example.com/?x=1&amp;y=2"');
    expect(email.html.match(/bgcolor="#FFD60A"/g)).toHaveLength(1);
    expect(email.html).toContain("mailto:help@example.com");
  });

  it("gives the same content as plain text", () => {
    expect(email.subject).toBe("Your code");
    expect(email.text).toContain("Enter it in LemonLime. See the docs (https://example.com/docs?a=1&b=2).");
    expect(email.text).toContain("123456");
    expect(email.text).toContain("Paid: $12");
    expect(email.text).toContain("Open LemonLime: https://app.example.com/?x=1&y=2");
    expect(email.text).toContain("Questions? Write to help@example.com");
    expect(email.text).not.toMatch(/<strong|<a |\*\*/);
    expect(email.text).not.toMatch(/\n{3,}/);
  });

  it("leaves out what isn't given", () => {
    const bare = renderEmail({ subject: "Hi", preview: "Hi", title: "Hi", intro: ["Hello."] }, { name: "X", appUrl: "https://x.test", logoUrl: "https://x.test/l.png" });
    expect(bare.html).not.toContain("mailto:");
    expect(bare.html).not.toContain('bgcolor="#FFD60A"');
    expect(bare.html).not.toContain("<img src=\"https://x.test/l.png\" width=\"480\"");
  });
});
