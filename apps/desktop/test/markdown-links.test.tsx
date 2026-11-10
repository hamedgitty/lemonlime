import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileLinksContext, inline, Markdown, mismatchedHost, trimBareUrl } from "../src/lib/markdown.tsx";

const open = () => {};
const links = (text: string) =>
  inline(text, open)
    .filter((n): n is ReactElement<{ url: string }> => isValidElement(n) && typeof (n.props as { url?: unknown }).url === "string")
    .map(n => n.props.url);
const plain = (text: string) =>
  inline(text, open)
    .filter(n => typeof n === "string")
    .join("|");

describe("a web address written out in a sentence", () => {
  it("becomes a link without the sentence's punctuation", () => {
    expect(links("See https://example.com/docs.")).toEqual(["https://example.com/docs"]);
    expect(plain("See https://example.com/docs.")).toBe("See |.");
    expect(links("Is it https://example.com/a?b=1, or http://localhost:3000/?")).toEqual(["https://example.com/a?b=1", "http://localhost:3000/"]);
  });

  it("keeps brackets that belong to the address and drops ones that wrap it", () => {
    expect(trimBareUrl("https://example.com/wiki/Lime_(fruit)")).toBe("https://example.com/wiki/Lime_(fruit)");
    expect(trimBareUrl("https://example.com/a).")).toBe("https://example.com/a");
    expect(links("(read https://example.com/a)")).toEqual(["https://example.com/a"]);
  });

  it("takes an address in angle brackets whole", () => {
    expect(links("<https://example.com/a.>")).toEqual(["https://example.com/a."]);
    expect(plain("at <https://example.com/a> now")).toBe("at | now");
  });

  it("leaves a named link, code and a scheme with nothing after it alone", () => {
    expect(links("[the docs](https://example.com/docs) and `https://example.com/x`")).toEqual(["https://example.com/docs"]);
    expect(links("http://.")).toEqual([]);
  });

  it("stays plain text where links can't be opened", () => {
    expect(inline("See https://example.com/docs.")).toEqual(["See ", "https://example.com/docs", "."]);
  });
});

describe("a link whose text names another site", () => {
  it("is told apart from one that names its own", () => {
    expect(mismatchedHost("github.com", "https://example.net/login")).toBe("example.net");
    expect(mismatchedHost("https://github.com/a/b", "https://github.com.example.net/a/b")).toBe("github.com.example.net");
    expect(mismatchedHost("www.example.com", "https://example.com/x")).toBeNull();
    expect(mismatchedHost("https://example.com/x", "https://example.com/x")).toBeNull();
  });

  it("ignores text that isn't an address", () => {
    expect(mismatchedHost("the docs", "https://example.com")).toBeNull();
    expect(mismatchedHost("README.md", "https://example.com/README.md")).toBeNull();
    expect(mismatchedHost("v1.2.3", "https://example.com/releases")).toBeNull();
  });

  it("shows the real site beside it", () => {
    const html = renderToStaticMarkup(<Markdown text="[github.com](https://example.net/login)" onLink={open} />);
    expect(html).toContain('title="https://example.net/login"');
    expect(html).toContain("(example.net)");
  });
});

describe("a link the agent wrote badly", () => {
  it("doesn't stop the reply from being drawn", () => {
    const files = { root: "/repo", open };
    const html = renderToStaticMarkup(
      <FileLinksContext.Provider value={files}>
        <Markdown text="[half](100%) and [bad](src/%E0%A4%A.ts) and [fine](src/app.ts)" onLink={open} />
      </FileLinksContext.Provider>,
    );
    expect(html).toContain("half");
    expect(html).toContain("bad");
    expect(html).toContain("Open src/app.ts");
  });
});
