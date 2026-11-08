import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containerName, createSandboxProvider, DockerProvider, type RunnerLaunch } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

/** A stand-in `docker` that logs its arguments and gives canned answers. */
function fakeDocker(): { bin: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  dirs.push(dir);
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
fs.appendFileSync(${JSON.stringify(log)}.replace("calls", "env"), JSON.stringify({ secret: process.env.LEMONLIME_THREAD_SECRET ?? null }) + "\\n");
const f = args[0] === "inspect" ? args[2] : "";
if (args[0] === "run") console.log("0123456789abcdef");
else if (f === "{{.State.Status}}") console.log("running");
else if (f === "{{.Name}}") console.log("/lemonlime-thread-abc123");
else if (args[0] === "port") console.log("0.0.0.0:49153");
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l) as string[]),
  };
}

const runner: RunnerLaunch = { command: "lemonlime-runner --thread thread-abc123", env: { LEMONLIME_THREAD_SECRET: "s" }, port: 7420 };

describe("DockerProvider", () => {
  it("publishes the runner port on the host by default", async () => {
    const d = fakeDocker();
    const p = new DockerProvider({ image: "img", docker: d.bin });
    const info = await p.create({ threadId: "thread-abc123", size: "small", runner, labels: {} });
    expect(info.runnerUrl).toBe("http://127.0.0.1:49153");
    const run = d.calls()[0]!;
    expect(run).toEqual(expect.arrayContaining(["-p", "127.0.0.1::7420", "--name", containerName("thread-abc123"), "lemonlime.runner-port=7420"]));
    expect(run).not.toContain("--network");
  });

  it("keeps secrets out of its command line, and runs an init that reaps finished processes", async () => {
    const d = fakeDocker();
    const p = new DockerProvider({ image: "img", docker: d.bin });
    await p.create({ threadId: "thread-abc123", size: "small", runner, labels: {} });
    const run = d.calls()[0]!;
    expect(run.join(" ")).not.toContain("LEMONLIME_THREAD_SECRET=s");
    expect(run).toEqual(expect.arrayContaining(["-e", "LEMONLIME_THREAD_SECRET", "--init"]));
    // The value reaches docker through its environment instead.
    const env = readFileSync(d.bin.replace(/docker$/, "env.jsonl"), "utf8")
      .trim()
      .split("\n")[0]!;
    expect(JSON.parse(env)).toEqual({ secret: "s" });
  });

  it("behind a proxy: joins the network, opens no port, and gives a path-based URL", async () => {
    const d = fakeDocker();
    const p = new DockerProvider({ image: "img", docker: d.bin, network: "lemonlime-sandboxes", publicUrl: "https://ll.example.com/sandbox/" });
    const info = await p.create({ threadId: "thread-abc123", size: "small", runner, labels: {} });
    expect(info.runnerUrl).toBe("https://ll.example.com/sandbox/lemonlime-thread-abc123");
    const run = d.calls()[0]!;
    expect(run).toEqual(expect.arrayContaining(["--network", "lemonlime-sandboxes"]));
    expect(run).not.toContain("-p");
  });

  it("with a separate agent user: starts as root with only the keeper's powers, and the keeper first", async () => {
    const d = fakeDocker();
    const p = new DockerProvider({ image: "img", docker: d.bin, agentUser: "agent" });
    await p.create({ threadId: "thread-abc123", size: "small", runner, labels: {} });
    const run = d.calls()[0]!;
    expect(run).toEqual(expect.arrayContaining(["--user", "root", "--cap-drop", "ALL", "no-new-privileges"]));
    expect(run.filter(a => a.startsWith("SET") || a === "KILL").sort()).toEqual(["KILL", "SETGID", "SETUID"]);
    const image = run.indexOf("img");
    expect(run.slice(image + 1, image + 8)).toEqual(["lemonlime-runner", "keeper", "--thread", "thread-abc123", "--agent-user", "agent", "--"]);
  });

  it("is configured from the environment", () => {
    const p = createSandboxProvider({ LEMONLIME_DOCKER_NETWORK: "n", LEMONLIME_DOCKER_PUBLIC_URL: "https://x/sandbox" }) as DockerProvider;
    expect(p).toBeInstanceOf(DockerProvider);
    expect((p as unknown as { opts: { network: string; publicUrl: string } }).opts).toMatchObject({ network: "n", publicUrl: "https://x/sandbox" });
  });
});
