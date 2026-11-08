import { describe, expect, it } from "vitest";
import { deliverFirstMessage, forgetFirstMessage, peekFirstMessage, queueFirstMessage } from "../src/lib/firstMessage.ts";

const file = (name: string, size = 3) => new File(["x".repeat(size)], name);

describe("files attached before the thread exists", () => {
  it("waits in the queue for the thread's runner", () => {
    queueFirstMessage("t1", { files: [file("a.txt")], permission: "plan" });
    expect(peekFirstMessage("t1")?.files.map(f => f.name)).toEqual(["a.txt"]);
    expect(peekFirstMessage("t1")?.permission).toBe("plan");
    forgetFirstMessage("t1");
    expect(peekFirstMessage("t1")).toBeUndefined();
  });

  it("queues nothing when there's nothing extra to take along", () => {
    queueFirstMessage("t2", { files: [] });
    expect(peekFirstMessage("t2")).toBeUndefined();
  });

  it("uploads every file, then sets the mode once connected, then sends the message with them", async () => {
    const log: string[] = [];
    let ready!: () => void;
    const connected = new Promise<void>(r => (ready = r));
    let n = 0;
    const done = deliverFirstMessage({ files: [file("a.png"), file("b.txt")], permission: "plan" }, "Look at these", {
      ready: () => connected,
      setPermission: mode => log.push(`mode ${mode}`),
      upload: async (f, id) => void log.push(`upload ${f.name} as ${id}`),
      send: (text, ids) => log.push(`send ${text} with ${ids.join(",")}`),
      newId: () => `up-${++n}`,
    });
    await new Promise(r => setTimeout(r, 0));
    // Uploads don't wait for the socket; the mode and the message do.
    expect(log).toEqual(["upload a.png as up-1", "upload b.txt as up-2"]);
    ready();
    expect(await done).toEqual({ sent: ["up-1", "up-2"], failed: [] });
    expect(log.slice(2)).toEqual(["mode plan", "send Look at these with up-1,up-2"]);
  });

  it("still sends the message when a file fails, and says which", async () => {
    const sent: string[][] = [];
    let n = 0;
    const result = await deliverFirstMessage({ files: [file("ok.txt"), file("bad.txt")] }, "Hi", {
      ready: async () => {},
      setPermission: () => {
        throw new Error("no mode was asked for");
      },
      upload: async f => {
        if (f.name === "bad.txt") throw new Error("disk full");
      },
      send: (_text, ids) => sent.push(ids),
      newId: () => `up-${++n}`,
    });
    expect(sent).toEqual([["up-1"]]);
    expect(result.failed).toEqual([{ name: "bad.txt", error: "disk full" }]);
  });
});
