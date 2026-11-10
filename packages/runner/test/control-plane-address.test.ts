import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { controlPlaneProblem } from "../src/cli.ts";

describe("the control plane address a runner is given", () => {
  it.each([
    "https://lemonlime.example.com",
    "https://lemonlime.example.com/base/",
    "http://localhost:3000",
    "http://app.localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.8.9.10",
    "http://[::1]:3000",
    // How services in one compose file reach each other.
    "http://proxy:8080",
    "http://web:3000",
    "http://host.docker.internal:3000",
    // Addresses and names that only exist on a private network.
    "http://192.168.1.20:3000",
    "http://10.0.0.5",
    "http://172.17.0.1:3000",
    "http://[fd12:3456:789a::1]:3000",
    "http://lemonlime.internal:3000",
    "http://nas.local:3000",
    "http://lemonlime.home.arpa",
    // The same private address, written as one number.
    "http://3232235796",
  ])("accepts %s", address => {
    expect(controlPlaneProblem(address)).toBeNull();
  });

  it.each([
    "http://lemonlime.example.com",
    "http://8.8.8.8:3000",
    // Next to the private ranges, not in them.
    "http://172.32.0.1",
    "http://192.169.1.20",
    "http://11.0.0.5",
    "http://[2001:db8::1]:3000",
    // Written as one number, this is still an address somewhere else.
    "http://134744072",
    "http://localhost.example.com",
    "http://internal.example.com",
    "http://evil.host.docker.internal.example.com",
  ])("refuses %s because it is plain http to another machine, and says what is accepted", address => {
    const problem = controlPlaneProblem(address);
    expect(problem).toContain("plain http");
    expect(problem).toContain("https://");
    expect(problem).toContain("localhost");
    expect(problem).toContain("Docker network");
  });

  it.each(["ftp://lemonlime.example.com", "not an address", "//lemonlime.example.com"])("refuses %s, which isn't a web address", address => {
    expect(controlPlaneProblem(address)).toMatch(/isn't a web address|must start with https/);
  });

  it("stops the runner from starting, before it listens or sends anything", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-control-plane-"));
    try {
      const child = spawn(
        process.execPath,
        [
          resolve(__dirname, "../bin/lemonlime-runner.js"),
          "--thread",
          "control-plane-1",
          "--agent",
          "claude-code",
          "--no-git",
          "--workdir",
          join(home, "work"),
          "--port",
          "0",
          "--control-plane",
          "http://lemonlime.example.com",
        ],
        { env: { ...process.env, HOME: home, LEMONLIME_HOME: join(home, ".lemonlime"), LEMONLIME_THREAD_SECRET: "c".repeat(64) } },
      );
      let printed = "";
      child.stdout.on("data", d => (printed += String(d)));
      child.stderr.on("data", d => (printed += String(d)));
      const code = await new Promise<number | null>(r => child.on("exit", r));
      expect(code).toBe(2);
      expect(printed).toContain("is plain http");
      expect(printed).not.toContain('"event":"ready"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
