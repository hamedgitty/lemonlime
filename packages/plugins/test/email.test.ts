import { describe, expect, it } from "vitest";
import { literalText, renderEmail, type EmailBrand } from "../src/index.ts";

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
      details: [
        { label: "Plan", value: "Team" },
        { label: "Paid", value: "$12", strong: true },
      ],
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

  it("shows text someone else typed as it is, never as bold or a link", () => {
    const name = "[Reset your password](https://bad.example/x) **now** <b>";
    const typed = renderEmail(
      {
        subject: "Hi",
        preview: "Hi",
        title: "Hi",
        intro: [`**${literalText(name)}** invited you. See [the docs](https://example.com/docs).`],
        details: [{ label: "From", value: literalText(name) }],
        note: `Sent by ${literalText(name)}.`,
        reason: `Because ${literalText(name)} asked.`,
      },
      brand,
    );
    expect(typed.html).not.toContain('href="https://bad.example');
    expect(typed.html).toMatch(/<strong[^>]*>\[Reset your password\]\(https:\/\/bad\.example\/x\) \*\*now\*\* &lt;b&gt;<\/strong> invited you\./);
    expect(typed.html).toContain('href="https://example.com/docs"');
    expect(typed.html).not.toMatch(/[\uE000-\uE004]/);
    expect(typed.text).toContain(`${name} invited you. See the docs (https://example.com/docs).`);
    expect(typed.text).toContain(`From: ${name}`);
    expect(typed.text).toContain(`Sent by ${name}.`);
    expect(typed.text).not.toMatch(/[\uE000-\uE004]/);
    // Without it, the same name would have become a link.
    expect(renderEmail({ subject: "Hi", preview: "Hi", title: "Hi", intro: [name] }, brand).html).toContain('href="https://bad.example/x"');
  });

  it("leaves out what isn't given", () => {
    const bare = renderEmail(
      { subject: "Hi", preview: "Hi", title: "Hi", intro: ["Hello."] },
      { name: "X", appUrl: "https://x.test", logoUrl: "https://x.test/l.png" },
    );
    expect(bare.html).not.toContain("mailto:");
    expect(bare.html).not.toContain('bgcolor="#FFD60A"');
    expect(bare.html).not.toContain('<img src="https://x.test/l.png" width="480"');
  });
});
