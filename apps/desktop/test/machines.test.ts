import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMachine,
  cleanMachineInput,
  hostProblem,
  loadMachines,
  rememberPath,
  remoteFolderName,
  remotePathProblem,
  removeMachine,
  saveMachines,
  updateMachine,
} from "../src/lib/machines.ts";

describe("SSH host checks", () => {
  it("accepts the forms people type", () => {
    for (const ok of ["devbox", "hamed@home-server.local", "me@100.64.0.7:2222", "box.tail1234.ts.net:22", "me@[fd7a::1]:2200", "[::1]"]) {
      expect(hostProblem(ok), ok).toBeNull();
    }
  });

  it("refuses anything that could become an ssh option or a second argument", () => {
    for (const bad of [
      "",
      "-oProxyCommand=touch /tmp/x",
      "host -oProxyCommand=x",
      "host\n-oProxyCommand=x",
      "host\tx",
      "me@-oProxyCommand=x",
      "-me@host",
      "me@host:0",
      "me@host:99999",
      "me@host:22x",
      "a@b@c",
      "host;rm -rf ~",
      "$(whoami)@host",
      "host'quote",
      ".hidden",
      "me@[fd7a::1",
      "host:22:33",
    ]) {
      expect(hostProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(hostProblem("-p")).toContain('start with "-"');
    expect(hostProblem("a b")).toContain("spaces");
    expect(hostProblem("me@host:70000")).toContain("port");
  });

  it("checks paths typed for the other machine", () => {
    expect(remotePathProblem("~/code/my app", "project folder")).toBeNull();
    expect(remotePathProblem("/srv/it's here", "project folder")).toBeNull();
    expect(remotePathProblem("", "project folder")).toContain("Enter the project folder");
    expect(remotePathProblem("-rf", "project folder")).not.toBeNull();
    expect(remotePathProblem("a\nb", "project folder")).not.toBeNull();
  });

  it("tidies a new machine, naming it after its host when left unnamed", () => {
    expect(cleanMachineInput({ name: "  ", host: " devbox ", runnerPath: " " })).toEqual({ value: { name: "devbox", host: "devbox", runnerPath: "" } });
    expect(cleanMachineInput({ name: "Box", host: "devbox", runnerPath: "-x" })).toHaveProperty("error");
    expect(cleanMachineInput({ name: "Box", host: "dev box", runnerPath: "" })).toHaveProperty("error");
  });

  it("names a remote folder by its last part", () => {
    expect(remoteFolderName("~/code/app/")).toBe("app");
    expect(remoteFolderName("/srv/my repo")).toBe("my repo");
  });
});

describe("machine storage", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("keeps machines in local storage and reads them back", () => {
    let list = addMachine([], { name: "Home server", host: "me@home:2222", runnerPath: "" }, "m-1");
    list = addMachine(list, { name: "Dev box", host: "devbox", runnerPath: "~/bin/lemonlime-runner" }, "m-2");
    list = updateMachine(list, "m-1", { name: "Attic", host: "me@home:2222", runnerPath: "" });
    list = rememberPath(list, "m-2", "~/code/a");
    list = rememberPath(list, "m-2", "~/code/b");
    list = rememberPath(list, "m-2", "~/code/a");
    saveMachines(list);
    expect(JSON.parse(store["lemonlime:machines"]!)).toHaveLength(2);
    const back = loadMachines();
    expect(back.map(m => m.name)).toEqual(["Attic", "Dev box"]);
    expect(back[1]!.recentPaths).toEqual(["~/code/a", "~/code/b"]);
    saveMachines(removeMachine(back, "m-1"));
    expect(loadMachines().map(m => m.id)).toEqual(["m-2"]);
  });

  it("holds nothing secret, and drops entries it can't trust", () => {
    saveMachines(addMachine([], { name: "Box", host: "devbox", runnerPath: "" }, "m-1"));
    expect(Object.keys(JSON.parse(store["lemonlime:machines"]!)[0]).sort()).toEqual(["host", "id", "name", "recentPaths", "runnerPath"]);
    store["lemonlime:machines"] = JSON.stringify([{ id: "x", name: "Bad", host: "-oProxyCommand=x" }, { id: "y" }, "nope"]);
    expect(loadMachines()).toEqual([]);
    store["lemonlime:machines"] = "{not json";
    expect(loadMachines()).toEqual([]);
  });
});
