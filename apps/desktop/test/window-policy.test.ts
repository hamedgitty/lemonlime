import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;

const conf = read("../src-tauri/tauri.conf.json") as { app: { security: { csp: Record<string, string> }; withGlobalTauri: boolean } };
const csp = conf.app.security.csp;
const sources = (directive: string) => (csp[directive] ?? "").split(/\s+/).filter(Boolean);

describe("the window's content security policy", () => {
  it("only runs the app's own scripts", () => {
    expect(sources("default-src")).toEqual(["'self'"]);
    // No script-src of its own, so scripts fall back to default-src: the app's own files.
    expect(csp["script-src"]).toBeUndefined();
    for (const directive of Object.keys(csp)) {
      expect(sources(directive)).not.toContain("'unsafe-eval'");
      expect(sources(directive)).not.toContain("*");
    }
    expect(conf.app.withGlobalTauri).toBe(false);
  });

  it("lets the app show what it loads from a runner", () => {
    // Sent images, and files opened in the Files tab, are fetched with the runner's token and shown from blob URLs.
    expect(sources("img-src")).toContain("blob:");
    expect(sources("media-src")).toContain("blob:");
    expect(sources("frame-src")).toContain("blob:");
  });

  it("frames nothing from the internet", () => {
    for (const source of sources("frame-src")) expect(source).toMatch(/^(blob:|http:\/\/(127\.0\.0\.1|localhost):\*)$/);
  });

  it("closes the doors the app never uses", () => {
    expect(sources("object-src")).toEqual(["'none'"]);
    expect(sources("base-uri")).toEqual(["'self'"]);
    expect(sources("form-action")).toEqual(["'self'"]);
    expect(sources("frame-ancestors")).toEqual(["'none'"]);
  });
});

describe("what the window may ask the shell to do", () => {
  const capability = read("../src-tauri/capabilities/default.json") as {
    windows: string[];
    remote?: unknown;
    permissions: (string | { identifier: string })[];
  };
  const names = capability.permissions.map(p => (typeof p === "string" ? p : p.identifier));

  it("is granted to the main window only, never to a web page", () => {
    expect(capability.windows).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
  });

  it("leaves out the shell and the file system", () => {
    for (const name of names) expect(name).not.toMatch(/^(shell|fs):/);
  });

  it("can't quit or restart the app by itself", () => {
    // Quitting and restarting go through the app's own commands, which ask first while an agent is working.
    for (const name of names) expect(name).not.toMatch(/^process:/);
  });
});
