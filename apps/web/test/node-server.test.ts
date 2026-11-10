import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const serverFile = fileURLToPath(new URL("../server.ts", import.meta.url));

/** The project files `server.ts` imports by path. */
function ownImports(): string[] {
  const source = readFileSync(serverFile, "utf8");
  // The quote sits in brackets so the boundary check doesn't read this pattern as an import.
  return [...source.matchAll(/from ["](\.\/[^"]+\.ts)["]/g)].map(m => fileURLToPath(new URL(m[1]!, new URL("../server.ts", import.meta.url))));
}

describe("the Node server's own files", () => {
  // `node server.ts` runs TypeScript by taking the types out and nothing more, so syntax
  // that needs compiling stops it from starting. The type checker and the bundlers accept
  // that syntax, which is why this asks Node itself.
  it("load on plain Node, along with everything they import", () => {
    const files = ownImports();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const out = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)}); console.log("loaded")`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(out.trim(), file).toBe("loaded");
    }
  }, 30_000);
});
