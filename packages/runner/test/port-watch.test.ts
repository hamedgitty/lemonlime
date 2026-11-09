import { describe, expect, it } from "vitest";
import { descendants, listeningPortsBelow, parseLsofListen, PortWatcher } from "../src/port-watch.ts";

const PS = `
    1     0
  100     1
  200   100
  201   200
  202   200
  300   201
  999     1
`;

const LSOF = ["p201", "fnode", "cnode", "n*:5173", "n[::1]:5173", "p300", "cpython3", "n127.0.0.1:8000", "n127.0.0.1:8000->127.0.0.1:5555", ""].join("\n");

describe("finding dev servers", () => {
  it("lists only the processes below the runner", () => {
    expect(descendants(PS, 200)).toEqual([201, 202, 300]);
    expect(descendants(PS, 300)).toEqual([]);
    expect(descendants("garbage\n", 1)).toEqual([]);
  });

  it("reads each listening port once, with its program", () => {
    expect(parseLsofListen(LSOF)).toEqual([
      { port: 5173, command: "node" },
      { port: 8000, command: "python3" },
    ]);
  });

  it("asks lsof about the runner's own process tree only", async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return file === "ps" ? PS : LSOF;
    };
    expect(await listeningPortsBelow(200, exec)).toHaveLength(2);
    expect(calls[1]).toEqual(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", "201,202,300", "-F", "pcn"]);
  });

  it("looks only while the thread is busy, skips its own ports, and reports changes once", async () => {
    let lsof = LSOF;
    let calls = 0;
    const seen: number[][] = [];
    const exec = async (file: string) => {
      calls++;
      return file === "ps" ? PS : lsof;
    };
    const w = new PortWatcher({
      root: 200,
      ignore: () => [8000],
      onChange: p => seen.push(p.map(x => x.port)),
      exec,
      intervalMs: 60_000,
      graceMs: 0,
      platform: "linux",
    });
    await w.poll();
    expect(calls).toBe(0); // idle: nothing runs
    w.busy(true);
    await w.poll();
    await w.poll();
    expect(seen).toEqual([[5173]]);
    lsof = "";
    await w.poll();
    expect(seen).toEqual([[5173], []]);
    w.stop();
    // Windows is skipped altogether.
    const before = calls;
    const win = new PortWatcher({ ignore: () => [], onChange: () => {}, platform: "win32", exec });
    win.busy(true);
    await win.poll();
    expect(calls).toBe(before);
  });
});
